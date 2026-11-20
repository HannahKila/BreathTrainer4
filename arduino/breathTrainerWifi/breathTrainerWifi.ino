// Breathe Trainer — UNO R4 WiFi
// 读 A1 的气压传感器,输出"相对静息基线的变化量"(和原来的 breathTrainer.ino 一样),
// 同时通过两条路发送:
//   1. USB 串口(115200)—— 电脑上的 Chrome 用 "Connect USB"
//   2. WiFi:http://<板子IP>/stream(Server-Sent Events)—— iPhone 用 "Connect WiFi"
//
// 使用前:在 arduino_secrets.h 里填好 WiFi 名称和密码(只能是 2.4GHz WiFi)。
// 上电后板子的 LED 点阵会滚动显示 IP 地址,串口监视器里也会打印。

#include <WiFiS3.h>
#include "ArduinoGraphics.h"     // 需要在"库管理"里安装 ArduinoGraphics
#include "Arduino_LED_Matrix.h"  // UNO R4 WiFi 自带
#include "arduino_secrets.h"

const int pressurePin = A1;
const unsigned long SAMPLE_INTERVAL_MS = 20;  // 50 次/秒,和原来一样

float baseline = 0;
unsigned long lastSampleAt = 0;

WiFiServer server(80);
WiFiClient streamClient;   // 当前正在接收数据的网页(一次一个)
ArduinoLEDMatrix matrix;

void showOnMatrix(const String &text) {
  matrix.beginDraw();
  matrix.stroke(0xFFFFFFFF);
  matrix.textScrollSpeed(60);
  matrix.textFont(Font_5x7);
  matrix.beginText(0, 1, 0xFFFFFF);
  matrix.println(text);
  matrix.endText(SCROLL_LEFT);
  matrix.endDraw();
}

void connectWifi() {
  if (WiFi.status() == WL_NO_MODULE) {
    Serial.println("WiFi module not found");
    return;
  }

  Serial.print("Connecting to WiFi: ");
  Serial.println(SECRET_SSID);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 10) {
    WiFi.begin(SECRET_SSID, SECRET_PASS);
    delay(3000);
    attempts++;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi failed — USB still works");
    showOnMatrix("NO WIFI");
    return;
  }

  // 刚连上时 IP 可能还是 0.0.0.0,稍等一下
  while (WiFi.localIP() == IPAddress(0, 0, 0, 0)) delay(200);

  server.begin();
  String ip = WiFi.localIP().toString();
  Serial.print("WiFi connected. Sensor IP: ");
  Serial.println(ip);
  showOnMatrix(ip);
}

// 有网页来连接时:读掉请求,回复 SSE 头,之后持续推送数据
void acceptClient() {
  WiFiClient incoming = server.available();
  if (!incoming) return;

  // 读完请求头(到空行为止),最多等 500ms
  String requestLine = "";
  String line = "";
  unsigned long start = millis();
  while (incoming.connected() && millis() - start < 500) {
    if (!incoming.available()) continue;
    char c = incoming.read();
    if (c == '\n') {
      if (requestLine.length() == 0) requestLine = line;
      if (line.length() <= 1) break;  // 空行("\r")= 请求头结束
      line = "";
    } else {
      line += c;
    }
  }

  if (requestLine.indexOf("GET /stream") == -1) {
    incoming.print(
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: text/plain\r\n"
      "Access-Control-Allow-Origin: *\r\n"
      "Connection: close\r\n\r\n"
      "Breathe Trainer sensor. Open /stream for data.\n");
    incoming.stop();
    return;
  }

  // 新网页连进来时,断开旧的
  if (streamClient && streamClient.connected()) streamClient.stop();

  incoming.print(
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: text/event-stream\r\n"
    "Cache-Control: no-cache\r\n"
    "Access-Control-Allow-Origin: *\r\n"
    "Connection: keep-alive\r\n\r\n"
    "retry: 1000\n\n");
  streamClient = incoming;
  Serial.println("Web client connected");
}

void setup() {
  Serial.begin(115200);
  matrix.begin();

  // 启动时保持静息,不要吹气
  long total = 0;
  for (int i = 0; i < 100; i++) {
    total += analogRead(pressurePin);
    delay(20);
  }
  baseline = total / 100.0;

  connectWifi();
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) acceptClient();

  unsigned long now = millis();
  if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
  lastSampleAt = now;

  int rawValue = analogRead(pressurePin);

  // 输出相对于静息基线的变化量
  float delta = rawValue - baseline;

  Serial.println(delta, 1);

  if (streamClient) {
    if (streamClient.connected()) {
      streamClient.print("data: ");
      streamClient.print(delta, 1);
      streamClient.print("\n\n");
    } else {
      streamClient.stop();
      Serial.println("Web client disconnected");
    }
  }
}
