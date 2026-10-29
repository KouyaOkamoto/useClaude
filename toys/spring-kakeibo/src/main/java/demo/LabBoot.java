package demo;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import demo.lab.LabControllers;
import org.springframework.boot.Banner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.boot.web.servlet.server.ServletWebServerFactory;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockServletConfig;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.DispatcherServlet;

/**
 * Stage C: Spring Boot の起動構成ごとの起動時間を測る（lab.html から呼ぶ）。
 * クラスの読み込みが時間の大部分なので、1つのページ（JVM）では1つの構成だけ起動して測る。
 *
 *   boot(spec)  spec は "jdbc" か "jpa" に、"+lazy" などの短縮の候補を付けたもの（OPTIONS）
 *   request()   起動した構成のコントローラに GET /lab/categories を1件流す
 */
public class LabBoot {

    @Configuration
    @EnableAutoConfiguration
    @Import(LabControllers.Jdbc.class)
    static class JdbcApp {
        @Bean
        ServletWebServerFactory noopServerFactory() {
            return Probe.noopServerFactory();
        }
    }

    @Configuration
    @EnableAutoConfiguration
    @EntityScan("demo.lab")
    @EnableJpaRepositories("demo.lab")
    @Import(LabControllers.Jpa.class)
    static class JpaApp {
        @Bean
        ServletWebServerFactory noopServerFactory() {
            return Probe.noopServerFactory();
        }
    }

    /** JPA を使わない構成では、JPA の自動構成を外す */
    static final String NO_JPA = "org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration";

    /** 家計簿に要らない自動構成 */
    static final String UNUSED = "org.springframework.boot.autoconfigure.websocket.servlet.WebSocketServletAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.web.servlet.MultipartAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.web.servlet.error.ErrorMvcAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.task.TaskExecutionAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.cache.CacheAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.data.web.SpringDataWebAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.info.ProjectInfoAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.availability.ApplicationAvailabilityAutoConfiguration";

    /** 起動を短くする候補。spec に "+名前" で付ける */
    static final Map<String, Map<String, Object>> OPTIONS = Map.of(
            "lazy", Map.of("spring.main.lazy-initialization", "true"),
            "osiv", Map.of("spring.jpa.open-in-view", "false"),
            "ddlnone", Map.of(
                    "spring.jpa.hibernate.ddl-auto", "none",
                    "spring.sql.init.mode", "always",
                    "spring.sql.init.schema-locations", "classpath:lab-schema.sql"),
            "meta", Map.of(
                    "spring.jpa.properties.hibernate.temp.use_jdbc_metadata_defaults", "false",
                    "spring.jpa.database-platform", "org.hibernate.dialect.H2Dialect"),
            "simpleds", Map.of("spring.datasource.type", "org.springframework.jdbc.datasource.SimpleDriverDataSource"),
            "hikari1", Map.of(
                    "spring.datasource.hikari.maximum-pool-size", "1",
                    "spring.datasource.hikari.minimum-idle", "1"),
            "unused", Map.of());

    private static ConfigurableApplicationContext context;
    private static DispatcherServlet dispatcher;

    public static String boot(String spec) {
        return Probe.run(() -> {
            String[] parts = spec.split("\\+");
            boolean jpa = parts[0].equals("jpa");
            Map<String, Object> props = new HashMap<>();
            props.put("logging.level.root", "WARN");
            props.put("spring.web.resources.add-mappings", "false");
            props.put("spring.datasource.url", "jdbc:h2:mem:lab;DB_CLOSE_DELAY=-1");
            props.put("spring.datasource.username", "sa");
            String exclude = jpa ? "" : NO_JPA;
            for (int i = 1; i < parts.length; i++) {
                if (!OPTIONS.containsKey(parts[i])) {
                    throw new IllegalArgumentException("unknown option: " + parts[i]);
                }
                props.putAll(OPTIONS.get(parts[i]));
                if (parts[i].equals("unused")) {
                    exclude = exclude.isEmpty() ? UNUSED : exclude + "," + UNUSED;
                }
            }
            if (!exclude.isEmpty()) {
                props.put("spring.autoconfigure.exclude", exclude);
            }

            SpringApplication app = new SpringApplication(jpa ? JpaApp.class : JdbcApp.class);
            app.setWebApplicationType(WebApplicationType.SERVLET);
            app.setBannerMode(Banner.Mode.OFF);
            app.setRegisterShutdownHook(false);
            app.setDefaultProperties(props);
            long t = System.currentTimeMillis();
            context = app.run();
            long run = System.currentTimeMillis() - t;
            DispatcherServlet servlet = context.getBean(DispatcherServlet.class);
            servlet.init(new MockServletConfig(((WebApplicationContext) context).getServletContext()));
            dispatcher = servlet;
            return spec + ": app.run " + run + "ms, beans=" + context.getBeanDefinitionCount()
                    + ", datasource=" + context.getBean(javax.sql.DataSource.class).getClass().getSimpleName();
        });
    }

    public static String request() {
        return Probe.run(() -> {
            MockHttpServletResponse res = new MockHttpServletResponse();
            dispatcher.service(new MockHttpServletRequest(((WebApplicationContext) context).getServletContext(), "GET", "/lab/categories"), res);
            return res.getStatus() + " " + res.getContentAsString(StandardCharsets.UTF_8);
        });
    }
}
