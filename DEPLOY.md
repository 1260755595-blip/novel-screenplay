# 镜界 · 小说漫剧工作台 - Render 部署指南

## 准备工作
- [ ] GitHub 账号（https://github.com 注册）
- [ ] Render 账号（已注册）

## 第一步：上传代码到 GitHub

1. 登录 GitHub，点击右上角 **+** → **New repository**
2. 仓库名填 `novel-screenplay`，选 **Public**，点 **Create repository**
3. 在本地（沙箱终端）执行以下命令，把代码推上去：

```bash
cd /workspace/novel-screenplay
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/你的用户名/novel-screenplay.git
git push -u origin main
```

> 注意：把 `你的用户名` 换成你的 GitHub 用户名

## 第二步：在 Render 上部署

1. 登录 Render (https://dashboard.render.com)
2. 点击 **New +** → **Web Service**
3. 选择 **Build and deploy from a Git repository**
4. 连接你的 GitHub 账号，选择 `novel-screenplay` 仓库
5. 配置页面填写：
   - **Name**: `novel-screenplay`（随意，会成为网址的一部分）
   - **Region**: 选离你近的（Singapore 新加坡）
   - **Branch**: `main`
   - **Runtime**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
6. 点击 **Create Web Service**

## 第三步：等待部署完成

- Render 会自动构建和部署，大约需要 2-5 分钟
- 看到 **Live** 绿色状态就成功了
- 你的网址会显示在页面顶部，格式为：`https://novel-screenplay-xxxxx.onrender.com`

## 第四步：使用

1. 打开部署好的网址
2. 首次打开会显示"创建管理员"界面，设置账号密码
3. 进入「系统设置」填入你的 DeepSeek API Key
4. 开始使用！

## ⚠️ 重要提示

### 数据持久化
Render 免费版**没有持久化磁盘**，每次重新部署数据会重置。
如果需要永久保存数据：
- 方案1：升级 Render 付费版，添加 Disk（$7/月），然后在环境变量设置 `DB_PATH=/data/app.db`
- 方案2：暂时用免费版测试，数据重置后重新创建管理员即可

### 免费版休眠
Render 免费版 15 分钟无请求会休眠，下次访问需要等待约 30 秒唤醒。

## 环境变量（可选）

在 Render 服务的 **Environment** 页面可以添加：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `DB_PATH` | `/data/app.db` | 持久化数据库路径（需先挂载 Disk） |
