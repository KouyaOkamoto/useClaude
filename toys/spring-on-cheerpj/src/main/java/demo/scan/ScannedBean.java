package demo.scan;

import org.springframework.stereotype.Component;

/** クラスパススキャン(@Component)が jar 内で機能するかを見るためのBean。 */
@Component
public class ScannedBean {
    public String hello() {
        return "hello from a component-scanned bean";
    }
}
