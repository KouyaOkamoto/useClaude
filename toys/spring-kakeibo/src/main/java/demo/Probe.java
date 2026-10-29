package demo;

import java.io.PrintWriter;
import java.io.StringWriter;

import javax.servlet.Filter;
import javax.servlet.FilterRegistration;
import javax.servlet.Servlet;
import javax.servlet.ServletException;
import javax.servlet.ServletRegistration;

import org.springframework.boot.web.server.WebServer;
import org.springframework.boot.web.servlet.ServletContextInitializer;
import org.springframework.boot.web.servlet.server.ServletWebServerFactory;
import org.springframework.mock.web.MockServletContext;

/**
 * サーバーを立てずに Spring MVC を動かすための共通部品（spring-on-cheerpj / spring-sw-bridge から引き継いだもの）。
 *
 *   noopServerFactory()  Tomcat の代わりの「何もしないサーバー」。ポートを開かず、MockServletContext を渡す
 *   run(step)            検証用（Lab / LabBoot）: 例外を投げず "OK <ms>ms\n…" / "FAIL <ms>ms\n<スタックトレース>" を返す
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
            return "FAIL " + (System.currentTimeMillis() - t) + "ms\n" + trace(e);
        }
    }

    static String trace(Throwable e) {
        StringWriter sw = new StringWriter();
        e.printStackTrace(new PrintWriter(sw));
        String s = sw.toString();
        return s.length() > 4000 ? s.substring(0, 4000) + "\n...(truncated)" : s;
    }

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

    /**
     * Tomcat の代わりの「何もしないサーバー」。起動するたびに新しい ServletContext を渡す
     * （同じ JVM で起動し直してもぶつからないように。起動後は context.getServletContext() で取り出す）
     */
    public static ServletWebServerFactory noopServerFactory() {
        // 本来は Tomcat が ServletContext を作って initializers に渡す。
        // それが無いと Spring MVC の初期化で "No ServletContext set" になるので、モックを渡す
        return initializers -> {
            MockServletContext servletContext = new NoServerServletContext();
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
