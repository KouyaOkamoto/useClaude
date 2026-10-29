package demo.kakeibo;

import javax.persistence.Column;
import javax.persistence.Entity;
import javax.persistence.EnumType;
import javax.persistence.Enumerated;
import javax.persistence.GeneratedValue;
import javax.persistence.GenerationType;
import javax.persistence.Id;
import javax.persistence.Table;

/** カテゴリ（食費・給与など）。名前はユニーク */
@Entity
@Table(name = "category")
public class Category {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    Long id;

    @Column(nullable = false, unique = true, length = 50)
    String name;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    CategoryType type;

    protected Category() {
    }

    Category(String name, CategoryType type) {
        this.name = name;
        this.type = type;
    }

    // 読むときは getter を使う（遅延読み込みのプロキシは、フィールドを直接読むと null になる）
    public Long getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public CategoryType getType() {
        return type;
    }
}
