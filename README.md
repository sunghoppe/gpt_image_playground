# GPT Image Playground

一个基于 OpenAI / Azure OpenAI 图像接口的 Web 图片生成与编辑工具。

## 功能

- 文本生成图片
- 上传参考图进行图片编辑
- 支持遮罩局部编辑
- 支持 OpenAI 和 Azure OpenAI
- 支持 Images API 和 Responses API
- 支持批量生成、历史记录、收藏与搜索
- Docker 部署时支持服务端持久化保存配置、任务和图片

## Docker 部署

推荐使用 Docker 部署，Node 服务会同时托管前端页面和后端 API。

生产环境更新代码后建议重新构建镜像，而不是只重启旧容器：

```bash
cd deploy
docker compose build --no-cache
docker compose up -d
```

### Docker CLI

```bash
docker run -d \
  --name gpt-image-playground \
  -p 8080:3000 \
  -e APP_LOGIN_KEY=你的登录密码 \
  -e APP_SECRET=一串很长的随机密钥 \
  -v ./data:/data \
  gpt-image-playground:local
```

### Docker Compose

```yaml
services:
  gpt-image-playground:
    image: gpt-image-playground:local
    container_name: gpt-image-playground
    environment:
      APP_LOGIN_KEY: 你的登录密码
      APP_SECRET: 一串很长的随机密钥
      DATA_DIR: /data
      SERVER_REQUEST_TIMEOUT_SECONDS: 900
    volumes:
      - ./data:/data
    ports:
      - "8080:3000"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
```

启动后访问：

```text
http://服务器IP:8080
```

## 本地开发

```bash
npm install
npm run dev
```

构建生产版本：

```bash
npm run build
```

启动 Node 服务：

```bash
npm run start
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `APP_LOGIN_KEY` | 网站访问密码，留空则关闭登录验证 |
| `APP_SECRET` | 用于加密保存 API Key 和签名登录 Cookie，部署后请保持固定 |
| `DATA_DIR` | 数据保存目录，默认 `/data` |
| `PORT` | 服务监听端口，默认 `3000` |
| `SERVER_REQUEST_TIMEOUT_SECONDS` | 服务端长请求超时，默认 `900` 秒 |
| `TASK_RUNNER_TIMEOUT_SECONDS` | 后台生成任务超时，默认 `1200` 秒 |
| `IMAGE_THUMBNAIL_MAX_WIDTH` | 卡片缩略图最长边，默认 `480` |
| `IMAGE_PREVIEW_MAX_WIDTH` | 详情预览图最长边，默认 `1600` |

## 反向代理

如果使用 1Panel / OpenResty / Nginx 反代到容器，请保留常见代理头和 Cookie：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Cookie $http_cookie;
proxy_pass_header Set-Cookie;
proxy_connect_timeout 60s;
proxy_send_timeout 900s;
proxy_read_timeout 900s;
send_timeout 900s;
```

当前生成流程由后端后台任务驱动，前端不会长时间占用反代连接。反代仍建议保留较长超时，方便下载、导入导出和调试旧代理接口。

如果域名接入 Cloudflare，建议确认：

- DNS 代理状态是否符合预期。
- 源站证书链完整。
- 需要长时间运行的请求尽量走后台任务，不依赖浏览器长连接。
- 源站防火墙可按需只放行 Cloudflare IP。

## 运维维护

### 日志查看

```bash
docker logs -f gpt-image-playground
docker logs --since=1h gpt-image-playground
```

Compose 已配置 Docker 日志轮转，避免日志长期增长撑满磁盘。

### 健康检查

容器健康检查访问：

```text
GET /api/health
```

返回 `{ "ok": true }` 表示 Node 服务可响应。

### 数据备份

核心数据在 `/data`，Compose 默认映射到 `deploy/data`：

- `/data/state.json`：配置、任务、图片索引、加密后的 API Key。
- `/data/images`：原图、缩略图、预览图。

建议定期备份整个数据目录：

```bash
tar -czf gpt-image-playground-data-$(date +%F).tar.gz ./data
```

恢复时保持 `APP_SECRET` 不变，否则已加密保存的 API Key 无法解密。

### 图片维护

历史图片没有缩略图时会在首次访问时自动生成，也可以调用维护接口提前补齐：

```bash
curl -X POST https://你的域名/api/maintenance/image-variants
```

清理没有被任何任务引用的孤立图片：

```bash
curl -X DELETE https://你的域名/api/maintenance/orphan-images
```

以上接口需要已登录 Cookie，建议只在浏览器登录后或内网环境中使用。

## API 配置

进入页面后点击右上角设置按钮，填写：

- API 提供商：OpenAI 或 Azure OpenAI
- API URL / Azure 资源 URL
- API Key
- 模型或 Azure Deployment 名称
- API 模式：Images API 或 Responses API

API Key 会加密保存在服务端数据目录中，前端只显示脱敏状态。

## License

MIT
