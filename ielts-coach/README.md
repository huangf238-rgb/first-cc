# 雅思口语教练（IELTS Speaking Coach）

在手机 Safari 里用的雅思听说练习 App：

- **跟读纠音**：你读句子，腾讯云「口语评测（新版）」给每个词、每个音打分（0–100），标出读错、漏读的音。
- **口语模拟**：Part 1 / 2 / 3 题目，录完后腾讯先打发音分，再由 **Claude Haiku 5.5** 按雅思评分标准估分、逐句改错、给 7 分示范回答。
- **听力**：雅思 Section 1 填表题，用手机自带的英语声音朗读，两个人用两种声音。
- **每晚总结**：每天 21:30（开罗时间）**Claude Opus 5.5** 自动分析当天的练习，写总结和明天的计划，并生成新的跟读句和一套新听力。
- **学习报告**：连续练习天数、14 天跟读分数走势、最弱的音和词、口语分数记录。

## 它是怎么搭起来的

```
iPhone Safari ──录音（16kHz PCM）──▶ Cloudflare Worker（你自己的免费服务器）
                                        ├─▶ 腾讯云口语评测（新版）WebSocket：发音打分
                                        ├─▶ Claude Haiku 5.5：每道口语题的点评
                                        ├─▶ Claude Opus 5.5：每晚总结（定时任务）
                                        └─▶ Durable Object（SQLite）：练习记录、密钥、设置
```

- 腾讯和 Claude 的密钥只保存在你自己 Cloudflare 账号的数据库里，不写进代码。
- App 用一个你自己设的口令保护，别人拿到网址也用不了。
- 为防止意外扣费，每天最多：发音评测 600 次、口语点评 80 次、手动生成总结 3 次。

## 费用

| 项目 | 价格 | 说明 |
|---|---|---|
| Cloudflare Workers | 免费 | 免费额度每天 10 万次请求，一个人用不完 |
| 腾讯云 口语评测（新版） | 首个资源包 1 万次 9.9 元 | 每个账号限买一个，一年有效；之后 15 万次 600 元 |
| Claude Haiku 5.5（每题点评） | 约 $0.002/次 | 每天 10 题一个月不到 $1 |
| Claude Opus 5.5（每晚总结） | 约 $0.10/次 | 一个月约 $3 |

Claude API 是按用量从预充值的余额里扣，**和 Claude App 的订阅是分开的**。

## 第一次设置（用户）

### 1. 腾讯云：开通口语评测（新版）
1. 打开 cloud.tencent.com 注册，完成**实名认证**（个人认证即可）。
2. 搜索「口语评测（新版）」，进入产品页开通服务，购买 **1 万次 9.9 元**的资源包。
   注意买的是**新版**；旧的「口语评测（基础版）」2027 年 6 月 30 日停止服务。
3. 右上角头像 › **账号信息**，记下 **APPID**（一串数字）。
4. 右上角头像 › **访问管理** › **API 密钥管理** › 新建密钥，记下 **SecretId** 和 **SecretKey**。

### 2. Claude API 密钥
1. 打开 platform.claude.com 登录（可以用和 Claude App 同一个账号）。
2. **Billing** 里充值（最少 5 美元）。
3. **API Keys** › Create Key，复制以 `sk-ant-` 开头的密钥。

### 3. Cloudflare：部署
1. 打开 dash.cloudflare.com 注册一个免费账号，进入一次 **Workers & Pages**（会自动分配一个 `xxx.workers.dev` 子域名）。
2. 右上角头像 › **My Profile** › **API Tokens** › **Create Token** › 选模板 **Edit Cloudflare Workers** › Account Resources 选你的账号、Zone Resources 选 All zones › **Continue to summary** › **Create Token**。
3. 把这个令牌填进 Claude 在对话里弹出的安全表单（**不要**直接发在聊天里）。Claude 用它部署，并告诉你网址和一次性的「初始化码」。

### 4. 在手机上打开 App
1. 用 **Safari** 打开 `https://ielts-coach.<你的子域名>.workers.dev`（不要在微信或 Claude App 里打开，那里不能录音）。
2. 填初始化码，自己设一个口令，再填腾讯云的 AppID / SecretId / SecretKey 和 Claude API 密钥。
3. 点「保存并测试连接」，两项都打勾就可以开始练了。
4. 第一次录音时 Safari 会问能不能用麦克风，选「允许」。想以后不再问：地址栏左边「大小」按钮 › 网站设置 › 麦克风 › 允许。

## 开发者说明

```bash
npm install
printf 'MOCK=1\nSETUP_CODE=local-test-code\n' > .dev.vars   # MOCK=1：不调用腾讯和 Claude，返回假数据
npx wrangler dev                                             # http://127.0.0.1:8787
npx tsc --noEmit                                             # 类型检查
npx wrangler deploy                                          # 部署（需要 CLOUDFLARE_API_TOKEN）
echo -n '<随机字符串>' | npx wrangler secret put SETUP_CODE  # 第一次设置用的初始化码
```

- `src/index.ts`：接口路由、每日定时任务
- `src/tencent.ts`：腾讯云口语评测（新版）的 WebSocket 接入。签名方式取自腾讯官方 Go SDK `tencentcloud-speech-sdk-go` v1.0.25 的 `soe/speaking_assessment.go`；使用 `rec_mode=1`（整段录音一次发送，腾讯文档写单段上限 60 秒），App 会把长回答按停顿切成不超过约 28 秒的几段
- `src/claude.ts`：Haiku 5.5 口语点评、Opus 5.5 每日总结（结构化输出；Opus 开启了拒答时自动换模型的兜底）
- `src/store.ts`：Durable Object（SQLite）存储与统计
- `public/`：手机网页（无框架、无外部依赖），录音用 Web Audio 采集后在手机上降采样成 16kHz 单声道 PCM
