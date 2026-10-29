-- Stage C（ddl-auto=none のとき）の検証用スキーマ
CREATE TABLE IF NOT EXISTS lab_category (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  type VARCHAR(10) NOT NULL
);
