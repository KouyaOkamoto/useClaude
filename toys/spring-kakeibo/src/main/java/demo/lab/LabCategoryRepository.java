package demo.lab;

import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;

public interface LabCategoryRepository extends JpaRepository<LabCategory, Long> {
    List<LabCategory> findByTypeOrderByNameAsc(String type);
}
