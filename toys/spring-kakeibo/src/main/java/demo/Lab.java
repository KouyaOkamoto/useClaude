package demo;

import java.io.File;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SimpleDriverDataSource;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

/**
 * DB がブラウザ内 JVM（CheerpJ）で動くかを段階ごとに確かめる検証用の入口（lab.html から呼ぶ）。
 * どのメソッドも例外を投げず、Probe と同じ "OK <ms>ms\n<詳細>" / "FAIL <ms>ms\n<スタックトレース>" を返す。
 *
 *   stageA       H2（インメモリ）+ JdbcTemplate: スキーマ作成・INSERT・SELECT・集計(GROUP BY)
 *   stageAQuery  上で作ったデータへの集計クエリだけ（2回目以降のリクエストに相当）
 *
 *   stageBWrite(v) / stageBRead(v) / stageBSync(v) / stageBClose(v)
 *                H2 のファイルモードで /files/（CheerpJ の永続領域。IndexedDB に保存される）に DB を置く。
 *                v は URL オプションの組み合わせの名前（VARIANTS）。接続は開きっぱなしにする（アプリと同じ）
 *   stageBDumpWrite / stageBDumpRead
 *                代替案: H2 はインメモリで動かし、書き込みのたびに SCRIPT TO で /files/ に SQL ダンプを保存、
 *                JVM が起動したら最初に RUNSCRIPT FROM で戻す
 *   stageBFiles  /files/kakeibo-lab の中身（ファイル名とサイズ）
 */
public class Lab {

    private static JdbcTemplate memory;

    static JdbcTemplate jdbc(String url) {
        return new JdbcTemplate(new SimpleDriverDataSource(new org.h2.Driver(), url, "sa", ""));
    }

    /** 家計簿と同じ形の表を作り、データを入れる */
    static String fill(JdbcTemplate db, int rows) {
        StringBuilder out = new StringBuilder();
        long t = System.currentTimeMillis();
        db.execute("CREATE TABLE IF NOT EXISTS category (id BIGINT AUTO_INCREMENT PRIMARY KEY,"
                + " name VARCHAR(50) NOT NULL UNIQUE, type VARCHAR(10) NOT NULL)");
        db.execute("CREATE TABLE IF NOT EXISTS tx (id BIGINT AUTO_INCREMENT PRIMARY KEY, date DATE NOT NULL,"
                + " amount BIGINT NOT NULL, category_id BIGINT NOT NULL REFERENCES category(id), memo VARCHAR(200))");
        out.append("schema ").append(System.currentTimeMillis() - t).append("ms");

        t = System.currentTimeMillis();
        db.update("MERGE INTO category (id, name, type) KEY (id) VALUES (1, '食費', 'EXPENSE'), (2, '交通費', 'EXPENSE'), (3, '給与', 'INCOME')");
        for (int i = 0; i < rows; i++) {
            db.update("INSERT INTO tx (date, amount, category_id, memo) VALUES (?, ?, ?, ?)",
                    java.sql.Date.valueOf(String.format("2026-10-%02d", 1 + i % 28)), 100L * (i + 1), 1 + i % 3, "row " + i);
        }
        out.append(" / insert ").append(rows).append(" rows ").append(System.currentTimeMillis() - t).append("ms");
        return out.toString();
    }

    /** カテゴリ別の合計（GROUP BY + JOIN） */
    static String summary(JdbcTemplate db) {
        long t = System.currentTimeMillis();
        List<Map<String, Object>> rows = db.queryForList(
                "SELECT c.name, c.type, COUNT(*) AS n, SUM(t.amount) AS total FROM tx t JOIN category c ON c.id = t.category_id"
                        + " WHERE t.date BETWEEN '2026-10-01' AND '2026-10-31' GROUP BY c.name, c.type ORDER BY total DESC");
        Long count = db.queryForObject("SELECT COUNT(*) FROM tx", Long.class);
        return "group by " + (System.currentTimeMillis() - t) + "ms rows=" + count + " " + rows;
    }

    public static String stageA() {
        return Probe.run(() -> {
            long t = System.currentTimeMillis();
            JdbcTemplate db = jdbc("jdbc:h2:mem:lab;DB_CLOSE_DELAY=-1");
            db.queryForObject("SELECT 1", Integer.class);
            String open = "open " + (System.currentTimeMillis() - t) + "ms";
            String fill = fill(db, 50);
            memory = db;
            return open + " / " + fill + "\n" + summary(db);
        });
    }

    public static String stageAQuery() {
        return Probe.run(() -> summary(memory));
    }

    // ------------------------------------------------------------------ Stage B

    /** 置き場所。通常の JVM で試すときは -Dlab.dir=... で変える */
    static final String DIR = System.getProperty("lab.dir", "/files/kakeibo-lab");

    /** ファイルモードで試す URL オプションの組み合わせ */
    static final Map<String, String> VARIANTS = Map.of(
            "default", "",
            "nolock", ";FILE_LOCK=NO",
            "nolock-wd0", ";FILE_LOCK=NO;WRITE_DELAY=0");

    private static final Map<String, SingleConnectionDataSource> open = new HashMap<>();

    /** 開いたままの接続を1本だけ持つ（接続を閉じると H2 は DB を閉じてしまうため、アプリと同じく開きっぱなしにする） */
    private static synchronized JdbcTemplate file(String variant, StringBuilder log) {
        SingleConnectionDataSource ds = open.get(variant);
        if (ds == null) {
            long t = System.currentTimeMillis();
            String url = "jdbc:h2:" + DIR + "/" + variant + VARIANTS.get(variant);
            ds = new SingleConnectionDataSource(url, "sa", "", true);
            ds.setDriverClassName("org.h2.Driver");
            new JdbcTemplate(ds).queryForObject("SELECT 1", Integer.class);
            open.put(variant, ds);
            log.append("open ").append(System.currentTimeMillis() - t).append("ms (").append(url).append(") / ");
        }
        return new JdbcTemplate(ds);
    }

    private static String rows(JdbcTemplate db) {
        Long n = db.queryForObject("SELECT COUNT(*) FROM tx", Long.class);
        List<String> last = db.queryForList("SELECT memo FROM tx ORDER BY id DESC LIMIT 3", String.class);
        return "rows=" + n + " last=" + last;
    }

    private static void schema(JdbcTemplate db) {
        db.execute("CREATE TABLE IF NOT EXISTS tx (id BIGINT AUTO_INCREMENT PRIMARY KEY, date DATE NOT NULL,"
                + " amount BIGINT NOT NULL, category_id BIGINT NOT NULL, memo VARCHAR(200))");
    }

    /** 1行書き込む（memo に時刻を入れて、どの書き込みが残ったか分かるようにする） */
    public static String stageBWrite(String variant) {
        return Probe.run(() -> {
            StringBuilder log = new StringBuilder();
            JdbcTemplate db = file(variant, log);
            schema(db);
            long t = System.currentTimeMillis();
            db.update("INSERT INTO tx (date, amount, category_id, memo) VALUES (CURRENT_DATE, 1000, 1, ?)",
                    "written " + java.time.LocalTime.now().withNano(0));
            log.append("insert ").append(System.currentTimeMillis() - t).append("ms\n");
            return log + rows(db);
        });
    }

    public static String stageBRead(String variant) {
        return Probe.run(() -> {
            StringBuilder log = new StringBuilder();
            JdbcTemplate db = file(variant, log);
            schema(db);
            return log + rows(db);
        });
    }

    /** 閉じずに、ディスクへの書き出しを強制する（CHECKPOINT SYNC。中で FileChannel.force を呼ぶ） */
    public static String stageBSync(String variant) {
        return Probe.run(() -> {
            StringBuilder log = new StringBuilder();
            JdbcTemplate db = file(variant, log);
            long t = System.currentTimeMillis();
            db.execute("CHECKPOINT SYNC");
            return log + "checkpoint sync " + (System.currentTimeMillis() - t) + "ms";
        });
    }

    /** DB をきちんと閉じる（SHUTDOWN） */
    public static synchronized String stageBClose(String variant) {
        return Probe.run(() -> {
            SingleConnectionDataSource ds = open.remove(variant);
            if (ds == null) {
                return "not open";
            }
            new JdbcTemplate(ds).execute("SHUTDOWN");
            ds.destroy();
            return "closed";
        });
    }

    // 代替案: インメモリ + SQL ダンプ
    private static JdbcTemplate dumpDb;

    private static synchronized JdbcTemplate dumpDb(StringBuilder log) {
        if (dumpDb == null) {
            JdbcTemplate db = jdbc("jdbc:h2:mem:dump;DB_CLOSE_DELAY=-1");
            File f = new File(DIR + "/dump.sql");
            long t = System.currentTimeMillis();
            if (f.exists()) {
                db.execute("RUNSCRIPT FROM '" + f.getPath() + "'");
                log.append("restore ").append(System.currentTimeMillis() - t).append("ms (").append(f.length()).append(" bytes) / ");
            } else {
                log.append("no dump yet / ");
            }
            schema(db);
            dumpDb = db;
        }
        return dumpDb;
    }

    /**
     * いまの中身を SQL ダンプに書き出す。書きかけのファイルで元のダンプを壊さないよう、
     * 一時ファイルに書いてから置き換える
     */
    private static void saveDump(JdbcTemplate db, StringBuilder log) {
        new File(DIR).mkdirs();
        File tmp = new File(DIR + "/dump.sql.tmp");
        File dump = new File(DIR + "/dump.sql");
        long t = System.currentTimeMillis();
        db.execute("SCRIPT TO '" + tmp.getPath() + "'");
        long written = System.currentTimeMillis() - t;
        dump.delete();
        boolean renamed = tmp.renameTo(dump);
        log.append("dump ").append(written).append("ms + rename ").append(renamed ? "ok" : "FAILED")
                .append(" (").append(dump.length()).append(" bytes)\n");
    }

    public static String stageBDumpWrite() {
        return Probe.run(() -> {
            StringBuilder log = new StringBuilder();
            JdbcTemplate db = dumpDb(log);
            db.update("INSERT INTO tx (date, amount, category_id, memo) VALUES (CURRENT_DATE, 1000, 1, ?)",
                    "written " + java.time.LocalTime.now().withNano(0));
            saveDump(db, log);
            return log + rows(db);
        });
    }

    /** n 行まとめて足してから書き出す（データが増えたときのダンプ・復元の時間を見る） */
    public static String stageBDumpBulk(String n) {
        return Probe.run(() -> {
            StringBuilder log = new StringBuilder();
            JdbcTemplate db = dumpDb(log);
            long t = System.currentTimeMillis();
            List<Object[]> args = new java.util.ArrayList<>();
            for (int i = 0; i < Integer.parseInt(n); i++) {
                args.add(new Object[] {java.sql.Date.valueOf(String.format("2026-%02d-%02d", 1 + i % 12, 1 + i % 28)),
                        100L + i, 1 + i % 3, "bulk " + i + " スーパーで買い物"});
            }
            db.batchUpdate("INSERT INTO tx (date, amount, category_id, memo) VALUES (?, ?, ?, ?)", args);
            log.append("insert ").append(n).append(" rows ").append(System.currentTimeMillis() - t).append("ms / ");
            saveDump(db, log);
            return log + rows(db);
        });
    }

    public static String stageBDumpRead() {
        return Probe.run(() -> {
            StringBuilder log = new StringBuilder();
            JdbcTemplate db = dumpDb(log);
            return log + rows(db);
        });
    }

    public static String stageBFiles() {
        return Probe.run(() -> {
            StringBuilder out = new StringBuilder();
            File[] files = new File(DIR).listFiles();
            if (files == null) {
                return "(no " + DIR + ")";
            }
            for (File f : files) {
                out.append(f.getName()).append(' ').append(f.length()).append(" bytes\n");
            }
            return out.toString();
        });
    }
}
