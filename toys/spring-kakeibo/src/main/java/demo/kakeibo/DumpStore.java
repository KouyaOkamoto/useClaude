package demo.kakeibo;

import java.io.File;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import javax.sql.DataSource;

import org.h2.util.ScriptReader;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.util.StreamUtils;

/**
 * DB の永続化（docs/results.md の Stage B で選んだ方式）。
 *
 * H2 はインメモリで動かし、書き込みが確定するたびに SCRIPT TO で SQL ダンプを /files/kakeibo/dump.sql に書く。
 * CheerpJ の /files/ は IndexedDB に保存されるが、ファイルを閉じるまで中身が保存されないため、
 * H2 のファイルモードではリロードでデータが消える（Stage B）。ダンプなら書き終えた時点で保存が済む。
 * 起動したら、まずダンプを RUNSCRIPT FROM で戻す。
 */
@Component
public class DumpStore {

    private final JdbcTemplate db;
    private final File dir;
    private final File dump;
    private final File tmp;

    private boolean ready;
    private String startedFrom;
    private String warning;
    private Instant lastSaved;
    private long lastBytes;

    DumpStore(DataSource dataSource, @Value("${kakeibo.data-dir}") String dataDir) {
        this.db = new JdbcTemplate(dataSource);
        this.dir = new File(dataDir);
        this.dump = new File(dir, "dump.sql");
        this.tmp = new File(dir, "dump.sql.tmp");
    }

    private static String quote(File f) {
        return "'" + f.getPath().replace("'", "''") + "'";
    }

    /** 起動時に1回: ダンプがあれば戻し、無ければスキーマと初期カテゴリを作る */
    public synchronized void ready() {
        if (ready) {
            return;
        }
        // 置き換えの途中で止まった（元を消したが、まだ名前を変えていない）ときは一時ファイルが完全なダンプ
        if (!dump.exists() && tmp.exists()) {
            tmp.renameTo(dump);
        }
        if (dump.exists()) {
            try {
                db.execute("RUNSCRIPT FROM " + quote(dump) + " CHARSET 'UTF-8'");
                startedFrom = "dump.sql (" + dump.length() + " bytes)";
            } catch (RuntimeException e) {
                // 読めないダンプは消さずに脇へよけ、空の状態で始める
                db.execute("DROP ALL OBJECTS");
                File broken = new File(dir, "dump.sql.broken-" + System.currentTimeMillis());
                dump.renameTo(broken);
                warning = "保存データを読み込めなかったため、空の状態で起動しました（" + broken.getName() + " に退避）: " + e.getMessage();
                fresh();
            }
        } else {
            fresh();
        }
        ready = true;
    }

    private void fresh() {
        try {
            String schema = StreamUtils.copyToString(new ClassPathResource("kakeibo-schema.sql").getInputStream(), StandardCharsets.UTF_8);
            for (String sql : statements(schema)) {
                db.execute(sql);
            }
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        for (String[] c : Samples.CATEGORIES) {
            db.update("INSERT INTO category (name, type) VALUES (?, ?)", c[0], c[1]);
        }
        startedFrom = "new";
        save();
    }

    /** いまの中身をダンプに書く。書きかけで元のダンプを壊さないよう、一時ファイルに書いてから置き換える */
    public synchronized void save() {
        dir.mkdirs();
        db.execute("SCRIPT TO " + quote(tmp) + " CHARSET 'UTF-8'");
        if (!tmp.renameTo(dump)) {
            dump.delete();
            if (!tmp.renameTo(dump)) {
                throw new IllegalStateException("could not replace " + dump);
            }
        }
        lastSaved = Instant.now();
        lastBytes = dump.length();
    }

    /** トランザクションが確定してから保存する（ロールバックされた変更は保存しない） */
    public void saveAfterCommit() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    save();
                }
            });
        } else {
            save();
        }
    }

    public Map<String, Object> status() {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("mode", "in-memory H2 + SQL dump");
        s.put("file", dump.getPath());
        s.put("startedFrom", startedFrom);
        s.put("lastSaved", lastSaved == null ? null : lastSaved.toString());
        s.put("bytes", lastBytes);
        if (warning != null) {
            s.put("warning", warning);
        }
        return s;
    }

    // ------------------------------------------------------------------ バックアップと復元

    /** DB 全体の SQL ダンプ（バックアップとしてダウンロードさせる） */
    public synchronized String backup() {
        List<String> lines = db.queryForList("SCRIPT", String.class);
        return "-- 家計簿のバックアップ " + Instant.now() + "\n" + String.join("\n", lines) + "\n";
    }

    /** バックアップに入っていてよい文の種類（H2 の SCRIPT が書き出すもの） */
    private static final List<String> ALLOWED = List.of(
            "CREATE USER ", "CREATE MEMORY TABLE ", "CREATE CACHED TABLE ", "CREATE TABLE ",
            "ALTER TABLE ", "INSERT INTO ", "CREATE INDEX ", "CREATE UNIQUE INDEX ", "CREATE SEQUENCE ",
            "SET DB_CLOSE_DELAY ");

    /** 文字列の外に出てきたら断る語（ファイルの読み書き・Java の呼び出しなど） */
    private static final Pattern DENIED = Pattern.compile(
            "\\b(CALL|ALIAS|TRIGGER|RUNSCRIPT|SCRIPT|FILE_READ|FILE_WRITE|CSVREAD|CSVWRITE|LINK_SCHEMA|LINKED|JAVA_OBJECT|DROP|DELETE|UPDATE|MERGE)\\b");

    static List<String> statements(String script) {
        List<String> out = new ArrayList<>();
        ScriptReader reader = new ScriptReader(new StringReader(script));
        reader.setSkipRemarks(true);
        for (String s = reader.readStatement(); s != null; s = reader.readStatement()) {
            String sql = s.trim();
            if (!sql.isEmpty()) {
                out.add(sql);
            }
        }
        return out;
    }

    /** 文字列リテラル（'…'・U&'…'）を消した残り */
    private static String withoutLiterals(String sql) {
        return sql.replaceAll("'(?:[^']|'')*'", "''");
    }

    /**
     * バックアップから戻す。いきなり本番の DB には流さず、別のインメモリ DB で
     * 「許された文だけか」「最後まで実行できるか」「家計簿の表がそろっているか」を確かめてから入れ替える
     */
    public synchronized Map<String, Object> restore(String script) {
        List<String> sqls = statements(script == null ? "" : script);
        if (sqls.isEmpty()) {
            throw ApiException.badRequest("バックアップが空です");
        }
        for (int i = 0; i < sqls.size(); i++) {
            String bare = withoutLiterals(sqls.get(i)).toUpperCase(Locale.ROOT);
            String head = bare.replaceAll("\\s+", " ");
            if (ALLOWED.stream().noneMatch(head::startsWith) || DENIED.matcher(bare).find()) {
                throw ApiException.badRequest((i + 1) + " 文目はバックアップに含められない文です: " + abbreviate(sqls.get(i)));
            }
        }

        SingleConnectionDataSource scratchDs = new SingleConnectionDataSource(
                "jdbc:h2:mem:restore-" + System.nanoTime(), "sa", "", true);
        scratchDs.setDriverClassName("org.h2.Driver");
        File checked = new File(dir, "restore.sql.tmp");
        try {
            JdbcTemplate scratch = new JdbcTemplate(scratchDs);
            for (int i = 0; i < sqls.size(); i++) {
                try {
                    scratch.execute(sqls.get(i));
                } catch (RuntimeException e) {
                    throw ApiException.badRequest((i + 1) + " 文目でエラーになりました: " + rootMessage(e));
                }
            }
            Map<String, Object> counts = new LinkedHashMap<>();
            try {
                scratch.queryForList("SELECT id, name, type FROM category WHERE 1 = 0");
                scratch.queryForList("SELECT id, tx_date, amount, category_id, memo FROM tx WHERE 1 = 0");
                counts.put("categories", scratch.queryForObject("SELECT COUNT(*) FROM category", Long.class));
                counts.put("transactions", scratch.queryForObject("SELECT COUNT(*) FROM tx", Long.class));
            } catch (RuntimeException e) {
                throw ApiException.badRequest("家計簿のバックアップではありません（表がそろっていません）: " + rootMessage(e));
            }
            // 確かめた DB から書き出し直したものを本番に入れる
            dir.mkdirs();
            scratch.execute("SCRIPT TO " + quote(checked) + " CHARSET 'UTF-8'");
            try {
                db.execute("DROP ALL OBJECTS");
                db.execute("RUNSCRIPT FROM " + quote(checked) + " CHARSET 'UTF-8'");
            } catch (RuntimeException e) {
                // 入れ替えに失敗したら、直前のダンプに戻す
                db.execute("DROP ALL OBJECTS");
                db.execute("RUNSCRIPT FROM " + quote(dump) + " CHARSET 'UTF-8'");
                throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "restore_failed",
                        "復元に失敗したため、元のデータに戻しました: " + rootMessage(e), null);
            }
            save();
            return counts;
        } finally {
            // バックアップの SET DB_CLOSE_DELAY -1 で、確かめ用の DB が残らないよう消す
            try {
                new JdbcTemplate(scratchDs).execute("SHUTDOWN");
            } catch (RuntimeException ignored) {
                // もう閉じている
            }
            scratchDs.destroy();
            checked.delete();
        }
    }

    private static String abbreviate(String sql) {
        String s = sql.replaceAll("\\s+", " ");
        return s.length() > 80 ? s.substring(0, 80) + "…" : s;
    }

    private static String rootMessage(Throwable e) {
        while (e.getCause() != null) {
            e = e.getCause();
        }
        String m = e.getMessage();
        return m == null ? e.toString() : m.split("\n")[0];
    }
}
