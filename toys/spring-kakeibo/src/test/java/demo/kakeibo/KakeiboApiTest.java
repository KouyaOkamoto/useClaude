package demo.kakeibo;

import static org.hamcrest.Matchers.contains;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.is;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * 家計簿の API を通常の JVM で確かめる（MockMvc）。ブラウザでは Bridge 経由で同じ DispatcherServlet に届く。
 * 集計・バリデーション・CSV の入出力・トランザクション（失敗時のロールバック）・永続化（ダンプ）・バックアップと復元。
 */
class KakeiboApiTest {

    static Path dataDir;
    static ConfigurableApplicationContext context;
    static MockMvc mvc;
    static JdbcTemplate db;
    static final ObjectMapper JSON = new ObjectMapper();

    /** データの置き場所と DB 名を指定して起動する（本番は /files/kakeibo と jdbc:h2:mem:kakeibo） */
    static ConfigurableApplicationContext start(Path dir) {
        return KakeiboApp.start(Map.of(
                "kakeibo.data-dir", dir.toString(),
                "spring.datasource.url", "jdbc:h2:mem:test-" + System.nanoTime() + ";DB_CLOSE_DELAY=-1"));
    }

    @BeforeAll
    static void boot() throws Exception {
        dataDir = Files.createTempDirectory("kakeibo-test");
        context = start(dataDir);
        mvc = mockMvc(context);
        db = new JdbcTemplate(context.getBean(javax.sql.DataSource.class));
    }

    /** 本番（Bridge）の DispatcherServlet と同じく、未定義のパスは例外にして ApiErrors で 404 の JSON にする */
    static MockMvc mockMvc(ConfigurableApplicationContext ctx) {
        return MockMvcBuilders.webAppContextSetup((WebApplicationContext) ctx)
                .addDispatcherServletCustomizer(d -> d.setThrowExceptionIfNoHandlerFound(true))
                .build();
    }

    /** 例外の原因をたどって、どこかに text が含まれているか */
    static boolean causedBy(Throwable e, String text) {
        for (; e != null; e = e.getCause()) {
            if (String.valueOf(e.getMessage()).contains(text)) {
                return true;
            }
        }
        return false;
    }

    @AfterAll
    static void close() {
        context.close();
    }

    /** 毎回サンプルデータの状態から始める */
    @BeforeEach
    void reset() throws Exception {
        mvc.perform(post("/api/_reset")).andExpect(status().isOk());
    }

    static ResultActions call(String method, String path, Object body) throws Exception {
        String content = body == null ? "" : body instanceof String ? (String) body : JSON.writeValueAsString(body);
        switch (method) {
            case "POST": return mvc.perform(post(path).contentType(MediaType.TEXT_PLAIN).content(content));
            case "PUT": return mvc.perform(put(path).contentType(MediaType.TEXT_PLAIN).content(content));
            case "DELETE": return mvc.perform(delete(path));
            default: return mvc.perform(get(path));
        }
    }

    static Object read(ResultActions r) throws Exception {
        String s = r.andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        return s.isEmpty() ? null : JSON.readValue(s, Object.class);
    }

    static long categoryId(String name) {
        return db.queryForObject("SELECT id FROM category WHERE name = ?", Long.class, name);
    }

    static long count(String table) {
        return db.queryForObject("SELECT COUNT(*) FROM " + table, Long.class);
    }

    static Map<String, Object> tx(String date, Object amount, Object categoryId, String memo) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("date", date);
        m.put("amount", amount);
        m.put("categoryId", categoryId);
        if (memo != null) {
            m.put("memo", memo);
        }
        return m;
    }

    // ------------------------------------------------------------------ カテゴリ

    @Test
    void categories() throws Exception {
        call("GET", "/api/categories", null).andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(Samples.CATEGORIES.length)))
                .andExpect(jsonPath("$[0].type", is("EXPENSE")))
                .andExpect(jsonPath("$[0].name", is("食費")))
                .andExpect(jsonPath("$[0].transactionCount", is(5)));

        MvcResult created = call("POST", "/api/categories", Map.of("name", "  ペット  ", "type", "EXPENSE"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.name", is("ペット")))
                .andReturn();
        long id = ((Number) JSON.readValue(created.getResponse().getContentAsString(), Map.class).get("id")).longValue();
        assertEquals("/api/categories/" + id, created.getResponse().getHeader("Location"));

        call("POST", "/api/categories", Map.of("name", "ペット", "type", "EXPENSE")).andExpect(status().isConflict());
        call("POST", "/api/categories", Map.of("name", "", "type", "EXPENSE")).andExpect(status().isBadRequest());
        call("POST", "/api/categories", Map.of("name", "x".repeat(51), "type", "EXPENSE")).andExpect(status().isBadRequest());
        call("POST", "/api/categories", Map.of("name", "a", "type", "OTHER")).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error", is("validation_error")))
                .andExpect(jsonPath("$.message", containsString("type")));

        call("PUT", "/api/categories/" + id, Map.of("name", "ペット用品", "type", "EXPENSE"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.name", is("ペット用品")));
        call("PUT", "/api/categories/" + id, Map.of("name", "食費", "type", "EXPENSE")).andExpect(status().isConflict());
        call("PUT", "/api/categories/99999", Map.of("name", "x", "type", "EXPENSE")).andExpect(status().isNotFound());

        // 取引で使っているカテゴリは消せない
        call("DELETE", "/api/categories/" + categoryId("食費"), null).andExpect(status().isConflict())
                .andExpect(jsonPath("$.error", is("conflict")));
        call("DELETE", "/api/categories/" + id, null).andExpect(status().isNoContent());
        call("DELETE", "/api/categories/" + id, null).andExpect(status().isNotFound());
        call("GET", "/api/categories/" + id, null).andExpect(status().isNotFound());
    }

    // ------------------------------------------------------------------ 取引

    @Test
    void transactionsCrudAndValidation() throws Exception {
        long food = categoryId("食費");
        MvcResult created = call("POST", "/api/transactions", tx("2026-01-15", 1200, food, " ランチ "))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.amount", is(1200)))
                .andExpect(jsonPath("$.categoryName", is("食費")))
                .andExpect(jsonPath("$.type", is("EXPENSE")))
                .andExpect(jsonPath("$.memo", is("ランチ")))
                .andReturn();
        long id = ((Number) JSON.readValue(created.getResponse().getContentAsString(), Map.class).get("id")).longValue();
        assertEquals("/api/transactions/" + id, created.getResponse().getHeader("Location"));

        // 不正な入力は 400（メッセージ付き）
        call("POST", "/api/transactions", tx("2026-02-30", 100, food, null)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message", containsString("date")));
        call("POST", "/api/transactions", tx("2026/01/15", 100, food, null)).andExpect(status().isBadRequest());
        call("POST", "/api/transactions", tx("2026-01-15", 0, food, null)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message", containsString("amount")));
        call("POST", "/api/transactions", tx("2026-01-15", 1.5, food, null)).andExpect(status().isBadRequest());
        call("POST", "/api/transactions", tx("2026-01-15", "100", food, null)).andExpect(status().isBadRequest());
        call("POST", "/api/transactions", tx("2026-01-15", 10_000_000_000L, food, null)).andExpect(status().isBadRequest());
        call("POST", "/api/transactions", tx("2026-01-15", 100, null, null)).andExpect(status().isBadRequest());
        call("POST", "/api/transactions", tx("2026-01-15", 100, 99999, null)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message", containsString("category 99999 not found")));
        call("POST", "/api/transactions", tx("2026-01-15", 100, food, "x".repeat(201))).andExpect(status().isBadRequest());
        call("POST", "/api/transactions", "{not json").andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message", is("body must be valid JSON")));
        call("POST", "/api/transactions", "[1,2]").andExpect(status().isBadRequest());

        // PUT は全置換（memo を省略すると消える）
        call("PUT", "/api/transactions/" + id, tx("2026-01-16", 980, categoryId("交通費"), null))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.categoryName", is("交通費")))
                .andExpect(jsonPath("$.memo").doesNotExist());
        call("GET", "/api/transactions/" + id, null).andExpect(jsonPath("$.amount", is(980)));
        call("PUT", "/api/transactions/99999", tx("2026-01-16", 980, food, null)).andExpect(status().isNotFound());

        call("DELETE", "/api/transactions/" + id, null).andExpect(status().isNoContent());
        call("DELETE", "/api/transactions/" + id, null).andExpect(status().isNotFound());
        call("GET", "/api/transactions/" + id, null).andExpect(status().isNotFound());
    }

    @Test
    void transactionFilters() throws Exception {
        long food = categoryId("食費");
        long train = categoryId("交通費");
        call("POST", "/api/transactions", tx("2025-03-01", 100, food, "100% オレンジ")).andExpect(status().isCreated());
        call("POST", "/api/transactions", tx("2025-03-15", 200, train, "Suica")).andExpect(status().isCreated());
        call("POST", "/api/transactions", tx("2025-04-01", 300, food, "スーパー")).andExpect(status().isCreated());

        call("GET", "/api/transactions?from=2025-03-01&to=2025-03-31", null)
                .andExpect(jsonPath("$[*].amount", contains(200, 100)));   // 新しい順
        call("GET", "/api/transactions?from=2025-03-01&to=2025-04-30&categoryId=" + food, null)
                .andExpect(jsonPath("$[*].amount", contains(300, 100)));
        call("GET", "/api/transactions?from=2025-01-01&to=2025-12-31&q=suica", null)
                .andExpect(jsonPath("$[*].amount", contains(200)));
        // % は文字そのものとして検索する（URL テンプレートだと %25 が二重にエンコードされるので param で渡す）
        mvc.perform(get("/api/transactions").param("from", "2025-01-01").param("to", "2025-12-31").param("q", "100%"))
                .andExpect(jsonPath("$[*].amount", contains(100)));
        // カテゴリ名でも検索できる
        call("GET", "/api/transactions?from=2025-01-01&to=2025-12-31&q=交通", null)
                .andExpect(jsonPath("$[*].amount", contains(200)));

        call("GET", "/api/transactions?from=2025-13-01", null).andExpect(status().isBadRequest());
        call("GET", "/api/transactions?from=2025-04-01&to=2025-03-01", null).andExpect(status().isBadRequest());
        call("GET", "/api/transactions?categoryId=abc", null).andExpect(status().isBadRequest());
    }

    // ------------------------------------------------------------------ 集計

    @Test
    void summary() throws Exception {
        mvc.perform(post("/api/_reset"));
        db.update("DELETE FROM tx");
        long food = categoryId("食費");
        long rent = categoryId("住居費");
        long salary = categoryId("給与");
        call("POST", "/api/transactions", tx("2025-06-01", 70000, rent, null));
        call("POST", "/api/transactions", tx("2025-06-03", 3000, food, null));
        call("POST", "/api/transactions", tx("2025-06-20", 2500, food, null));
        call("POST", "/api/transactions", tx("2025-06-25", 250000, salary, null));
        call("POST", "/api/transactions", tx("2025-07-01", 99999, food, null));   // 翌月は数えない
        call("POST", "/api/transactions", tx("2025-05-31", 99999, food, null));   // 前月も

        call("GET", "/api/summary?month=2025-06", null).andExpect(status().isOk())
                .andExpect(jsonPath("$.month", is("2025-06")))
                .andExpect(jsonPath("$.income", is(250000)))
                .andExpect(jsonPath("$.expense", is(75500)))
                .andExpect(jsonPath("$.balance", is(174500)))
                .andExpect(jsonPath("$.expenses[*].name", contains("住居費", "食費")))   // 多い順
                .andExpect(jsonPath("$.expenses[1].total", is(5500)))
                .andExpect(jsonPath("$.incomes[0].name", is("給与")));
        call("GET", "/api/summary?month=2025-01", null)
                .andExpect(jsonPath("$.income", is(0))).andExpect(jsonPath("$.expenses", hasSize(0)));
        call("GET", "/api/summary?month=2025-13", null).andExpect(status().isBadRequest());
        call("GET", "/api/summary?month=202506", null).andExpect(status().isBadRequest());
    }

    // ------------------------------------------------------------------ ルーティング

    @Test
    void routing() throws Exception {
        call("GET", "/api/nope", null).andExpect(status().isNotFound()).andExpect(jsonPath("$.error", is("not_found")));
        call("GET", "/api/transactions/abc", null).andExpect(status().isNotFound());
        call("DELETE", "/api/transactions", null).andExpect(status().isMethodNotAllowed())
                .andExpect(header().string("Allow", "GET, POST"))
                .andExpect(jsonPath("$.error", is("method_not_allowed")));
        call("POST", "/api/categories/1", "{}").andExpect(status().isMethodNotAllowed())
                .andExpect(header().string("Allow", "GET, PUT, DELETE"));
        call("POST", "/api/health", "{}").andExpect(status().isMethodNotAllowed());
        call("GET", "/api/health", null).andExpect(status().isOk())
                .andExpect(jsonPath("$.persistence.mode", is("in-memory H2 + SQL dump")));
    }

    // ------------------------------------------------------------------ CSV

    @Test
    void csvExport() throws Exception {
        db.update("DELETE FROM tx");
        long food = categoryId("食費");
        call("POST", "/api/transactions", tx("2025-02-01", 1200, food, "カンマ,と\"引用符\""));
        call("POST", "/api/transactions", tx("2025-01-31", 300, categoryId("給与"), "改行\nあり"));
        MvcResult r = call("GET", "/api/export.csv", null).andExpect(status().isOk())
                .andExpect(header().string("Content-Type", "text/csv; charset=UTF-8"))
                .andExpect(header().string("Content-Disposition", containsString("attachment; filename=\"kakeibo-")))
                .andReturn();
        String csv = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertEquals(Csv.BOM + "日付,種別,カテゴリ,金額,メモ\r\n"
                + "2025-01-31,収入,給与,300,\"改行\nあり\"\r\n"
                + "2025-02-01,支出,食費,1200,\"カンマ,と\"\"引用符\"\"\"\r\n", csv);
    }

    @Test
    void csvRoundTrip() throws Exception {
        String csv = call("GET", "/api/export.csv", null).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        List<?> before = (List<?>) read(call("GET", "/api/transactions", null));
        db.update("DELETE FROM tx");
        call("POST", "/api/import", csv).andExpect(status().isOk())
                .andExpect(jsonPath("$.imported", is(Samples.ENTRIES.length)))
                .andExpect(jsonPath("$.createdCategories", hasSize(0)));
        List<?> after = (List<?>) read(call("GET", "/api/transactions", null));
        assertEquals(strip(before), strip(after));
    }

    /** id を除いて比べる */
    @SuppressWarnings("unchecked")
    static List<Object> strip(List<?> list) {
        return list.stream().map(o -> {
            Map<String, Object> m = new java.util.LinkedHashMap<>((Map<String, Object>) o);
            m.remove("id");
            return m;
        }).collect(java.util.stream.Collectors.toList());
    }

    @Test
    void csvImportCreatesCategoriesAndAcceptsBom() throws Exception {
        String csv = Csv.BOM + "日付,種別,カテゴリ,金額,メモ\n2025-08-01,支出,ペット,\"1,500\",フード\n\n2025-08-02,収入,お小遣い,3000,\n";
        call("POST", "/api/import", csv).andExpect(status().isOk())
                .andExpect(jsonPath("$.imported", is(2)))
                .andExpect(jsonPath("$.createdCategories", contains("ペット", "お小遣い")));
        call("GET", "/api/transactions?from=2025-08-01&to=2025-08-31", null)
                .andExpect(jsonPath("$[*].amount", contains(3000, 1500)))
                .andExpect(jsonPath("$[1].categoryName", is("ペット")))
                .andExpect(jsonPath("$[0].type", is("INCOME")));
    }

    @Test
    void csvImportRejectsWholeFileWithLineNumbers() throws Exception {
        long txBefore = count("tx");
        long catBefore = count("category");
        String csv = "日付,種別,カテゴリ,金額,メモ\r\n"
                + "2025-08-01,支出,食費,500,ok\r\n"                    // 2行目: 正しい
                + "2025-08-32,支出,食費,500,\r\n"                      // 3行目: 日付
                + "2025-08-01,支出,新カテゴリ,0,\r\n"                  // 4行目: 金額
                + "2025-08-01,支出,\"複数行\nのメモ\",500,\"a\r\nb\"\r\n"   // 5〜7行目: 正しい（カテゴリ名に改行を含む）
                + "2025-08-01,その他,食費,500,\r\n"                    // 8行目: 種別
                + "2025-08-01,収入,食費,500,\r\n"                      // 9行目: 食費は支出
                + "2025-08-01,支出,食費\r\n";                          // 10行目: 列の数
        call("POST", "/api/import", csv).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error", is("validation_error")))
                .andExpect(jsonPath("$.message", containsString("5 行に問題がある")))
                .andExpect(jsonPath("$.errors[*].line", contains(3, 4, 8, 9, 10)))
                .andExpect(jsonPath("$.errors[0].message", containsString("日付")))
                .andExpect(jsonPath("$.errors[1].message", containsString("金額")))
                .andExpect(jsonPath("$.errors[3].message", containsString("支出として登録されています")));
        // 1行も取り込まれず、カテゴリも作られない
        assertEquals(txBefore, count("tx"));
        assertEquals(catBefore, count("category"));

        call("POST", "/api/import", "date,amount\n2025-01-01,1").andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].line", is(1)));
        call("POST", "/api/import", "日付,種別,カテゴリ,金額,メモ\n\"閉じていない").andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].message", containsString("閉じていません")));
        call("POST", "/api/import", "").andExpect(status().isBadRequest());
    }

    // ------------------------------------------------------------------ トランザクション

    /** DB の中で途中の行が失敗しても、取り込みは何も残さない（作りかけのカテゴリも消える）。ダンプも書かれない */
    @Test
    void importRollsBackWhenDatabaseFailsMidway() throws Exception {
        long txBefore = count("tx");
        long catBefore = count("category");
        byte[] dumpBefore = Files.readAllBytes(dataDir.resolve("dump.sql"));
        db.execute("CREATE TRIGGER fail_tx BEFORE INSERT ON tx FOR EACH ROW CALL 'demo.kakeibo.FailTrigger'");
        try {
            String csv = "日付,種別,カテゴリ,金額,メモ\n"
                    + "2025-09-01,支出,新しいカテゴリ,100,1件目\n"
                    + "2025-09-02,支出,食費,200,2件目\n"
                    + "2025-09-03,支出,食費,300,FAIL\n"
                    + "2025-09-04,支出,食費,400,4件目\n";
            Exception e = assertThrows(Exception.class, () -> call("POST", "/api/import", csv));
            assertTrue(causedBy(e, "FailTrigger"), String.valueOf(e));
        } finally {
            db.execute("DROP TRIGGER fail_tx");
        }
        assertEquals(txBefore, count("tx"));
        assertEquals(catBefore, count("category"));
        assertEquals(0L, db.queryForObject("SELECT COUNT(*) FROM category WHERE name = '新しいカテゴリ'", Long.class));
        assertEquals(new String(dumpBefore, StandardCharsets.UTF_8),
                new String(Files.readAllBytes(dataDir.resolve("dump.sql")), StandardCharsets.UTF_8));
    }

    /** _reset が途中で失敗しても、元のデータが残る */
    @Test
    void resetRollsBackWhenDatabaseFailsMidway() throws Exception {
        call("POST", "/api/transactions", tx("2025-09-09", 777, categoryId("食費"), "消えてはいけない"));
        long txBefore = count("tx");
        // サンプルの取引を入れようとしたら失敗するトリガー（その前の全件削除は済んでいる）
        db.execute("CREATE TRIGGER fail_all BEFORE INSERT ON tx FOR EACH ROW CALL 'demo.kakeibo.FailAllTrigger'");
        try {
            assertThrows(Exception.class, () -> call("POST", "/api/_reset", null));
        } finally {
            db.execute("DROP TRIGGER fail_all");
        }
        assertEquals(txBefore, count("tx"));
        assertEquals(1L, db.queryForObject("SELECT COUNT(*) FROM tx WHERE memo = '消えてはいけない'", Long.class));
        assertEquals((long) Samples.CATEGORIES.length, count("category"));
    }

    // ------------------------------------------------------------------ 永続化・バックアップ

    /** 書き込みはダンプに保存され、同じ場所で起動し直すと戻る（リロードに相当） */
    @Test
    void persistsAcrossRestart() throws Exception {
        call("POST", "/api/categories", Map.of("name", "再起動テスト", "type", "INCOME")).andExpect(status().isCreated());
        call("POST", "/api/transactions", tx("2025-10-10", 4321, categoryId("再起動テスト"), "残るはず"));
        List<?> before = (List<?>) read(call("GET", "/api/transactions", null));
        List<?> cats = (List<?>) read(call("GET", "/api/categories", null));

        ConfigurableApplicationContext second = start(dataDir);
        try {
            MockMvc mvc2 = mockMvc(second);
            String body = mvc2.perform(get("/api/transactions")).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
            assertEquals(before, JSON.readValue(body, List.class));
            String catBody = mvc2.perform(get("/api/categories")).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
            assertEquals(cats, JSON.readValue(catBody, List.class));
            mvc2.perform(get("/api/health")).andExpect(jsonPath("$.persistence.startedFrom", containsString("dump.sql")));
            // 採番も続きから（同じ id を二度使わない）
            mvc2.perform(post("/api/transactions").contentType(MediaType.TEXT_PLAIN)
                    .content(JSON.writeValueAsString(tx("2025-10-11", 1, categoryId("食費"), null))))
                    .andExpect(status().isCreated());
        } finally {
            second.close();
        }
    }

    @Test
    void backupAndRestore() throws Exception {
        MvcResult b = call("GET", "/api/backup.sql", null).andExpect(status().isOk())
                .andExpect(header().string("Content-Disposition", containsString("kakeibo-backup-")))
                .andReturn();
        String backup = b.getResponse().getContentAsString(StandardCharsets.UTF_8);
        List<?> before = (List<?>) read(call("GET", "/api/transactions", null));

        // データを消す（ブラウザのデータ消去に相当）
        db.update("DELETE FROM tx");
        call("DELETE", "/api/categories/" + categoryId("通信費"), null).andExpect(status().isNoContent());

        call("POST", "/api/restore", backup).andExpect(status().isOk())
                .andExpect(jsonPath("$.transactions", is(Samples.ENTRIES.length)))
                .andExpect(jsonPath("$.categories", is(Samples.CATEGORIES.length)));
        assertEquals(before, read(call("GET", "/api/transactions", null)));
        // 復元した中身もダンプに保存されている（H2 のダンプは日本語を U&'\901a\4fe1\8cbb' のように書く）
        assertTrue(new String(Files.readAllBytes(dataDir.resolve("dump.sql")), StandardCharsets.UTF_8)
                .contains("U&'\\901a\\4fe1\\8cbb'"));
    }

    @Test
    void restoreRejectsUnsafeOrForeignScripts() throws Exception {
        List<?> before = (List<?>) read(call("GET", "/api/transactions", null));
        String backup = call("GET", "/api/backup.sql", null).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        call("POST", "/api/restore", backup + "\nCALL FILE_WRITE('x', 'y');").andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message", containsString("含められない文")));
        call("POST", "/api/restore", "CREATE ALIAS X FOR 'java.lang.System.exit';").andExpect(status().isBadRequest());
        call("POST", "/api/restore", "INSERT INTO tx VALUES (FILE_READ('/etc/passwd'));").andExpect(status().isBadRequest());
        call("POST", "/api/restore", "CREATE TABLE foo (id INT);").andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message", containsString("家計簿のバックアップではありません")));
        call("POST", "/api/restore", "これはSQLではない").andExpect(status().isBadRequest());
        call("POST", "/api/restore", "").andExpect(status().isBadRequest());
        // メモに "CALL" などの語があっても、文字列の中なら問題ない
        call("POST", "/api/transactions", tx("2025-11-01", 100, categoryId("通信費"), "CALL センター; DROP"));
        String withWords = call("GET", "/api/backup.sql", null).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        call("POST", "/api/restore", withWords).andExpect(status().isOk());
        call("POST", "/api/restore", backup).andExpect(status().isOk());
        // 断った復元のあとも、データはそのまま
        assertEquals(before, read(call("GET", "/api/transactions", null)));
    }

    /** 壊れたダンプがあっても起動でき、壊れたファイルは消さずに残す */
    @Test
    void brokenDumpIsSetAside() throws Exception {
        Path dir = Files.createTempDirectory("kakeibo-broken");
        Files.write(dir.resolve("dump.sql"), "これは壊れたダンプ".getBytes(StandardCharsets.UTF_8));
        ConfigurableApplicationContext ctx = start(dir);
        try {
            MockMvc m = mockMvc(ctx);
            m.perform(get("/api/health")).andExpect(jsonPath("$.persistence.warning", containsString("dump.sql.broken-")));
            m.perform(get("/api/categories")).andExpect(jsonPath("$", hasSize(Samples.CATEGORIES.length)));
            File[] broken = dir.toFile().listFiles((d, n) -> n.startsWith("dump.sql.broken-"));
            assertEquals(1, broken.length);
            assertTrue(new File(dir.toFile(), "dump.sql").exists());
        } finally {
            ctx.close();
        }
    }

    /** 置き換えの途中で止まった（dump.sql が無く一時ファイルだけある）ときは、一時ファイルから戻す */
    @Test
    void recoversFromInterruptedSave() throws Exception {
        Path dir = Files.createTempDirectory("kakeibo-tmp");
        Files.copy(dataDir.resolve("dump.sql"), dir.resolve("dump.sql.tmp"));
        ConfigurableApplicationContext ctx = start(dir);
        try {
            MockMvc m = mockMvc(ctx);
            m.perform(get("/api/health")).andExpect(jsonPath("$.persistence.startedFrom", containsString("dump.sql")));
            assertFalse(new File(dir.toFile(), "dump.sql.tmp").exists());
        } finally {
            ctx.close();
        }
    }
}
