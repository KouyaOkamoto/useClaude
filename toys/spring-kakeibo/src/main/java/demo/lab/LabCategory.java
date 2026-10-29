package demo.lab;

import javax.persistence.Column;
import javax.persistence.Entity;
import javax.persistence.GeneratedValue;
import javax.persistence.GenerationType;
import javax.persistence.Id;
import javax.persistence.Table;

/** Stage C の検証用エンティティ（家計簿のカテゴリと同じ形） */
@Entity
@Table(name = "lab_category")
public class LabCategory {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(nullable = false, unique = true, length = 50)
    public String name;

    @Column(nullable = false, length = 10)
    public String type;

    protected LabCategory() {
    }

    public LabCategory(String name, String type) {
        this.name = name;
        this.type = type;
    }
}
