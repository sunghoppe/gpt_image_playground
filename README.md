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

图片生成可能耗时较长。如果反代保持默认超时，常见表现是在生成过程中返回 `504 Gateway Timeout`。

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
