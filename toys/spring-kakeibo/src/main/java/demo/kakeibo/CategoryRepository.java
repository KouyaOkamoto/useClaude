package demo.kakeibo;

import java.util.List;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface CategoryRepository extends JpaRepository<Category, Long> {
    Optional<Category> findByName(String name);

    /** 支出 → 収入（文字列で EXPENSE < INCOME）、作った順 */
    @Query("select c from Category c order by c.type, c.id")
    List<Category> findAllOrdered();
}
