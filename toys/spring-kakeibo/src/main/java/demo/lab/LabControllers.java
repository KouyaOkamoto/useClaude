package demo.lab;

import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Stage C の検証用コントローラ。同じ中身を JdbcTemplate と JPA で返す */
public class LabControllers {

    @RestController
    public static class Jdbc {
        private final JdbcTemplate db;

        Jdbc(JdbcTemplate db) {
            this.db = db;
            db.execute("CREATE TABLE IF NOT EXISTS lab_category (id BIGINT AUTO_INCREMENT PRIMARY KEY,"
                    + " name VARCHAR(50) NOT NULL UNIQUE, type VARCHAR(10) NOT NULL)");
        }

        @GetMapping("/lab/categories")
        public List<Map<String, Object>> list() {
            db.update("MERGE INTO lab_category (name, type) KEY (name) VALUES ('食費', 'EXPENSE')");
            return db.queryForList("SELECT * FROM lab_category WHERE type = ? ORDER BY name", "EXPENSE");
        }
    }

    @RestController
    public static class Jpa {
        private final LabCategoryRepository repo;

        Jpa(LabCategoryRepository repo) {
            this.repo = repo;
        }

        @GetMapping("/lab/categories")
        public List<LabCategory> list() {
            if (repo.count() == 0) {
                repo.save(new LabCategory("食費", "EXPENSE"));
            }
            return repo.findByTypeOrderByNameAsc("EXPENSE");
        }
    }
}
