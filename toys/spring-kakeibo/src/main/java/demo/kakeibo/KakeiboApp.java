package demo.kakeibo;

import java.util.HashMap;
import java.util.Map;

import demo.Probe;
import org.springframework.boot.Banner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.boot.web.servlet.server.ServletWebServerFactory;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

/**
 * 家計簿アプリの Spring Boot 構成。サーバーは立てず、DispatcherServlet に直接リクエストを流す（Bridge）。
 *
 * DB は H2 のインメモリで動かし、書き込みのたびに SQL ダンプを /files/kakeibo/ に保存する（DumpStore）。
 * 起動を短くする設定は docs/results.md の Stage C で効果を測って選んだもの。
 */
@Configuration
@EnableAutoConfiguration
@ComponentScan
@EntityScan
@EnableJpaRepositories
public class KakeiboApp {

    @Bean
    ServletWebServerFactory noopServerFactory() {
        return Probe.noopServerFactory();
    }

    /** 起動時の設定。テストでは dataDir などを上書きする */
    static Map<String, Object> properties() {
        Map<String, Object> p = new HashMap<>();
        p.put("logging.level.root", "WARN");
        p.put("spring.web.resources.add-mappings", "false");
        // 未定義のパスを 404 の例外にして、ApiErrors で JSON を返す
        p.put("spring.mvc.throw-exception-if-no-handler-found", "true");
        p.put("spring.datasource.url", "jdbc:h2:mem:kakeibo;DB_CLOSE_DELAY=-1");
        p.put("spring.datasource.username", "sa");
        // --- Stage C で効果があった起動短縮 ---
        p.put("spring.main.lazy-initialization", "true");
        p.put("spring.jpa.open-in-view", "false");
        // スキーマは DumpStore が schema.sql / ダンプから作る
        p.put("spring.jpa.hibernate.ddl-auto", "none");
        p.put("spring.sql.init.mode", "never");
        p.put("spring.jpa.properties.hibernate.temp.use_jdbc_metadata_defaults", "false");
        p.put("spring.jpa.database-platform", "org.hibernate.dialect.H2Dialect");
        // 1人で使うインメモリ DB なので、接続プール（Hikari）は使わない
        p.put("spring.datasource.type", "org.springframework.jdbc.datasource.SimpleDriverDataSource");
        p.put("kakeibo.data-dir", "/files/kakeibo");
        return p;
    }

    public static ConfigurableApplicationContext start(Map<String, Object> overrides) {
        Map<String, Object> props = properties();
        props.putAll(overrides);
        SpringApplication app = new SpringApplication(KakeiboApp.class);
        app.setWebApplicationType(WebApplicationType.SERVLET);
        app.setBannerMode(Banner.Mode.OFF);
        app.setRegisterShutdownHook(false);
        app.setDefaultProperties(props);
        ConfigurableApplicationContext context = app.run();
        // lazy-initialization なので、DB の復元はここで済ませておく（最初のリクエストを待たない）
        context.getBean(DumpStore.class).ready();
        return context;
    }
}
