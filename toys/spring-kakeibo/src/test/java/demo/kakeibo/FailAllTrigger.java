package demo.kakeibo;

import java.sql.Connection;
import java.sql.SQLException;

import org.h2.api.Trigger;

/** テスト用: どの取引を入れようとしても、DB の中でエラーにする */
public class FailAllTrigger implements Trigger {
    @Override
    public void fire(Connection conn, Object[] oldRow, Object[] newRow) throws SQLException {
        throw new SQLException("FailAllTrigger: 途中で失敗させた");
    }
}
