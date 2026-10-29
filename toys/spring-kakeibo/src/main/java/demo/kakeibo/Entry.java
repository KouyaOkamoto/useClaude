package demo.kakeibo;

import java.time.LocalDate;

import javax.persistence.Column;
import javax.persistence.Entity;
import javax.persistence.FetchType;
import javax.persistence.GeneratedValue;
import javax.persistence.GenerationType;
import javax.persistence.Id;
import javax.persistence.JoinColumn;
import javax.persistence.ManyToOne;
import javax.persistence.Table;

/** 取引1件（API では transaction と呼ぶ。JPA の Transaction と紛らわしいのでクラス名は Entry） */
@Entity
@Table(name = "tx")
public class Entry {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    Long id;

    @Column(name = "tx_date", nullable = false)
    LocalDate date;

    /** 円の整数。1以上 */
    @Column(nullable = false)
    long amount;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "category_id", nullable = false)
    Category category;

    @Column(length = 200)
    String memo;

    protected Entry() {
    }

    Entry(LocalDate date, long amount, Category category, String memo) {
        this.date = date;
        this.amount = amount;
        this.category = category;
        this.memo = memo;
    }
}
