package demo;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import javax.servlet.Filter;
import javax.servlet.FilterRegistration;
import javax.servlet.Servlet;
import javax.servlet.ServletException;
import javax.servlet.ServletRegistration;

import com.fasterxml.jackson.databind.ObjectMapper;
import demo.scan.ScannedBean;
import org.springframework.boot.Banner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.web.server.WebServer;
import org.springframework.boot.web.servlet.server.ServletWebServerFactory;
import org.springframework.boot.web.servlet.ServletContextInitializer;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockServletConfig;
import org.springframework.mock.web.MockServletContext;
import org.springframework.web.servlet.DispatcherServlet;

/**
 * CheerpJ(ブラウザ内JVM)上で、Spring がどの段階まで動くかを切り分けるための検証用エントリポイント。
 * JavaScript から static メソッドとして呼ぶ。どのメソッドも例外を投げず、
 * "OK <ms>ms\n<詳細>" か "FAIL <ms>ms\n<スタックトレース>" の文字列を返す。
 *
 *   level0     素のJava（JVMの基本情報）
 *   level1     Spring Framework 単体: DIコンテナ + @Configuration(CGLIB)
 *   level1Scan Spring Framework: クラスパススキャン(@Component)
 *   level2     Spring Boot（Webなし）: SpringApplication + 自動構成 + Jackson
 *   level3     Spring Boot + Spring MVC を「サーバーを立てずに」直接ディスパッチ
 */
public class Probe {

    interface Step {
        String run() throws Throwable;
    }

    static String run(Step step) {
        long t = System.currentTimeMillis();
        try {
            String result = step.run();
            return "OK " + (System.currentTimeMillis() - t) + "ms\n" + result;
        } catch (Throwable e) {
            StringWriter sw = new StringWriter();
            e.printStackTrace(new PrintWriter(sw));
            String trace = sw.toString();
            if (trace.length() > 4000) {
                trace = trace.substring(0, 4000) + "\n...(truncated)";
            }
            return "FAIL " + (System.currentTimeMillis() - t) + "ms\n" + trace;
        }
    }

    // ------------------------------------------------------------------ level 0

    public static String level0() {
        return run(() -> "java.version=" + System.getProperty("java.version")
                + " vm=" + System.getProperty("java.vm.name")
                + " processors=" + Runtime.getRuntime().availableProcessors()
                + " maxMemoryMB=" + Runtime.getRuntime().maxMemory() / (1024 * 1024));
    }

    // ------------------------------------------------------------------ level 1

    static class Greeter {
        String greet(String name) {
            return "hello " + name;
        }
    }

    @Configuration
    static class CoreConfig {
        @Bean
        Greeter greeter() {
            return new Greeter();
        }
    }

    public static String level1() {
        return run(() -> {
            try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext(CoreConfig.class)) {
                return ctx.getBean(Greeter.class).greet("CheerpJ") + " (beans=" + ctx.getBeanDefinitionCount() + ")";
            }
        });
    }

    public static String level1Scan() {
        return run(() -> {
            try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext("demo.scan")) {
                return ctx.getBean(ScannedBean.class).hello();
            }
        });
    }

    // ------------------------------------------------------------------ level 2

    @Configuration
    @EnableAutoConfiguration
    static class BootCore {
    }

    public static String level2() {
        return run(() -> {
            SpringApplication app = new SpringApplication(BootCore.class);
            app.setWebApplicationType(WebApplicationType.NONE);
            app.setBannerMode(Banner.Mode.OFF);
            app.setRegisterShutdownHook(false);
            app.setDefaultProperties(Map.of("logging.level.root", "WARN"));
            try (ConfigurableApplicationContext ctx = app.run()) {
                String json = ctx.getBean(ObjectMapper.class).writeValueAsString(Map.of("boot", true));
                return "beans=" + ctx.getBeanDefinitionCount() + " json=" + json;
            }
        });
    }

    // ------------------------------------------------------------------ level 3

    /** 何もしない WebServer。ポートを開かず、起動したことにするだけ。 */
    static class NoopWebServer implements WebServer {
        @Override
        public void start() {
        }

        @Override
        public void stop() {
        }

        @Override
        public int getPort() {
            return -1;
        }
    }

    @Configuration
    @EnableAutoConfiguration
    @Import(TodoController.class)
    static class WebApp {
        /** Tomcat の代わりに「何もしないサーバー」を差し込み、ソケット待受を回避する。 */
        @Bean
        ServletWebServerFactory noopServerFactory() {
            // 本来は Tomcat が ServletContext を作って initializers に渡す。
            // それが無いと Spring MVC の初期化で "No ServletContext set" になるので、モックを渡す
            return initializers -> {
                for (ServletContextInitializer initializer : initializers) {
                    try {
                        initializer.onStartup(servletContext);
                    } catch (ServletException e) {
                        throw new IllegalStateException(e);
                    }
                }
                return new NoopWebServer();
            };
        }
    }

    /**
     * サーバーの代わりの ServletContext。DispatcherServlet などの登録は受け付けずに null を返す
     * （Spring Boot は null を「登録済み」とみなして先へ進む）。DispatcherServlet はこちらで直接呼ぶ。
     */
    static class NoServerServletContext extends MockServletContext {
        @Override public ServletRegistration.Dynamic addServlet(String name, String className) { return null; }
        @Override public ServletRegistration.Dynamic addServlet(String name, Servlet servlet) { return null; }
        @Override public ServletRegistration.Dynamic addServlet(String name, Class<? extends Servlet> c) { return null; }
        @Override public FilterRegistration.Dynamic addFilter(String name, String className) { return null; }
        @Override public FilterRegistration.Dynamic addFilter(String name, Filter filter) { return null; }
        @Override public FilterRegistration.Dynamic addFilter(String name, Class<? extends Filter> c) { return null; }
    }

    private static ConfigurableApplicationContext webContext;
    private static final MockServletContext servletContext = new NoServerServletContext();
    private static DispatcherServlet dispatcher;

    private static synchronized void ensureWeb() throws Exception {
        if (dispatcher != null) {
            return;
        }
        SpringApplication app = new SpringApplication(WebApp.class);
        app.setWebApplicationType(WebApplicationType.SERVLET);
        app.setBannerMode(Banner.Mode.OFF);
        app.setRegisterShutdownHook(false);
        app.setDefaultProperties(Map.of(
                "logging.level.root", "WARN",
                "spring.web.resources.add-mappings", "false"));
        webContext = app.run();

        DispatcherServlet servlet = webContext.getBean(DispatcherServlet.class);
        servlet.init(new MockServletConfig(servletContext));
        dispatcher = servlet;
    }

    /** サーバー無しで DispatcherServlet にリクエストを直接流す。戻り値は "OK <ms>ms\n<status>\n<body>"。 */
    public static String level3(String method, String path, String body) {
        return run(() -> {
            ensureWeb();
            MockHttpServletRequest req = new MockHttpServletRequest(servletContext, method, path);
            if (body != null && !body.isEmpty()) {
                req.setContentType("application/json");
                req.setCharacterEncoding("UTF-8");
                req.setContent(body.getBytes(StandardCharsets.UTF_8));
            }
            MockHttpServletResponse res = new MockHttpServletResponse();
            dispatcher.service(req, res);
            return res.getStatus() + "\n" + res.getContentAsString(StandardCharsets.UTF_8);
        });
    }
}
