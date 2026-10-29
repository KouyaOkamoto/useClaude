package demo.kakeibo;

import java.sql.Connection;
import java.sql.SQLException;

import org.h2.api.Trigger;

/** テスト用: memo が "FAIL" の取引を入れようとしたら、DB の中でエラーにする（途中失敗のロールバックを確かめる） */
public class FailTrigger implements Trigger {
    @Override
    public void fire(Connection conn, Object[] oldRow, Object[] newRow) throws SQLException {
        if (newRow != null && "FAIL".equals(newRow[4])) {
            throw new SQLException("FailTrigger: 途中で失敗させた");
        }
    }
}
