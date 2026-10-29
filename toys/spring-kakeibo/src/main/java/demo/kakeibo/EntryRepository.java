package demo.kakeibo;

import java.time.LocalDate;
import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface EntryRepository extends JpaRepository<Entry, Long> {
    boolean existsByCategoryId(Long categoryId);

    /** カテゴリごとの件数 [categoryId, count] */
    @Query("select e.category.id, count(e) from Entry e group by e.category.id")
    List<Object[]> countByCategory();

    /** 期間内のカテゴリ別合計 [categoryId, name, type, total] */
    @Query("select c.id, c.name, c.type, sum(e.amount) from Entry e join e.category c"
            + " where e.date between :from and :to group by c.id, c.name, c.type")
    List<Object[]> totalsByCategory(@Param("from") LocalDate from, @Param("to") LocalDate to);

    /** CSV 書き出し用（日付の古い順） */
    @Query("select e from Entry e join fetch e.category order by e.date, e.id")
    List<Entry> findAllForExport();
}
