# Linkbuilder - 博客评论外链自动发现与发布插件

一款 Chrome 浏览器扩展插件，帮助你从 Semrush 导出的外链数据中自动筛选可评论的博客文章，并利用 AI 生成评论内容、自动填写表单发布。

## 功能

- **Excel 导入与筛选**：导入 Semrush 导出的 .xlsx 外链表格，自动过滤 SPAM、失效链接，优先排序 UGC 和博客类 URL
- **博客页面分析**：自动打开外链页面，识别评论表单，判断是否需要登录
- **AI 评论生成**：调用 Gemini 2.5 Flash 根据文章内容生成自然、相关的评论
- **半自动/全自动发布**：自动填写评论表单，支持人工审核后提交或全自动提交
- **滚雪球发现**：从已有博客评论中提取其他站长的网站链接，发现更多外链资源
- **数据导出**：将筛选结果和发现的新网站导出为 CSV
- **侧边栏模式**：以 Side Panel 形式固定在浏览器右侧，可以一边浏览网页一边观察插件运行状态

## 快速开始

### 1. 安装插件

1. 下载或克隆本仓库到本地
2. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions/`
3. 打开右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本项目文件夹
5. 插件图标出现在浏览器工具栏
6. 点击插件图标，侧边栏会在浏览器右侧打开并固定

### 2. 配置 API Key

1. 在侧边栏中进入 **Settings** 标签页
2. 填入你的 Gemini API Key（从 [Google AI Studio](https://aistudio.google.com/apikey) 免费获取）
3. 点击 **Save Settings**

### 3. 导入外链数据

1. 登录 Semrush，进入你想分析的竞争对手域名的外链报告
2. 导出外链列表为 .xlsx 文件
3. 点击插件图标，进入 **Import** 标签页
4. 点击上传区域或拖拽 .xlsx 文件到上传区域
5. 插件会自动解析并筛选，显示筛选结果统计
6. 点击 **Save to Database** 保存到本地数据库

**筛选规则说明：**
- 过滤 Page Ascore = 0 的 SPAM 页面
- 过滤已失效链接（Lost link = true）
- 过滤外链数量过多的页面（疑似链接农场）
- UGC 标记的链接优先排序（大概率是评论区）
- 含 `/blog/`、`/comment-page-` 等特征的 URL 优先

### 4. 分析外链页面

1. 进入 **Backlinks** 标签页，可以看到已导入的外链列表
2. 点击 **Analyze All**，插件会逐个打开每条外链：
   - 判断页面是否有评论表单
   - 识别表单字段（姓名、邮箱、网站、评论内容）
   - 判断是否需要登录注册
   - 自动提取评论区中其他站长留下的网站链接
3. 分析完成后，每条外链会被标记为 `commentable`（可评论）或 `not_commentable`（不可评论）
4. 使用顶部下拉框按状态筛选

### 5. 发布评论

1. 进入 **Publish** 标签页
2. 填写你的信息：
   - **Your Name**：显示在评论区的昵称
   - **Your Email**：评论用的邮箱
   - **Your Website URL**：你要推广的网站地址（这就是你获得的外链）
3. 选择发布模式：
   - **Semi-Auto**（推荐）：插件填好表单后暂停，你检查无误后手动点提交
   - **Full Auto**：插件自动填写并提交，无需人工干预
4. 点击 **Start Publishing**，查看下方日志区域了解发布进度

### 6. 导出数据

在 **Settings** 标签页底部：
- **Export Backlinks**：导出所有外链数据为 CSV
- **Export Discovered Sites**：导出从评论区发现的新网站列表（可以拿这些网站去 Semrush 继续查外链，形成滚雪球效应）

## 项目结构

```
├── manifest.json            # 插件配置
├── background.js            # 后台服务（Tab 管理、表单注入）
├── content/analyzer.js      # 页面分析脚本（评论表单识别、链接提取）
├── lib/
│   ├── db.js                # IndexedDB 数据库封装
│   ├── filter.js            # Semrush 数据解析与筛选规则
│   ├── gemini.js            # Gemini 2.5 Flash AI 接口
│   ├── i18n.js              # 中英文双语翻译
│   └── xlsx.full.min.js     # Excel 解析库
├── popup/                   # 插件弹出窗口界面
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── options/options.html     # 设置页面
└── icons/                   # 插件图标
```

## 成本

- **Gemini 2.5 Flash** 免费层级：输入输出完全免费，从 [Google AI Studio](https://aistudio.google.com/apikey) 获取 API Key 即可使用
- 需要 Semrush 账号来导出竞争对手的外链数据

## 注意事项

- 建议先使用半自动模式，确认效果后再切换为全自动
- 博客评论外链适合低竞争关键词场景（小游戏站、工具站、新词新站等）
- 注意控制发布频率，避免短时间内大量发布
- nofollow 外链同样有价值，不要忽略
- forum 类外链比例不要过高，以免触发降权信号
