package demo;

import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SimpleDriverDataSource;

/**
 * DB がブラウザ内 JVM（CheerpJ）で動くかを段階ごとに確かめる検証用の入口（lab.html から呼ぶ）。
 * どのメソッドも例外を投げず、Probe と同じ "OK <ms>ms\n<詳細>" / "FAIL <ms>ms\n<スタックトレース>" を返す。
 *
 *   stageA       H2（インメモリ）+ JdbcTemplate: スキーマ作成・INSERT・SELECT・集計(GROUP BY)
 *   stageAQuery  上で作ったデータへの集計クエリだけ（2回目以降のリクエストに相当）
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
}
