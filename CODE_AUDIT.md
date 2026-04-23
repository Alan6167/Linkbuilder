# Linkbuilder 代码审计报告（2026-04-23）

> 审计范围：`manifest.json`、`background.js`、`content/analyzer.js`、`popup/popup.js`、`lib/db.js`、`lib/filter.js`、`lib/gemini.js`。
> 方法：静态代码审查（无动态渗透测试）。

## 总体结论

- 安全基线：**中等风险**。
- 主要问题集中在：
  1. 扩展权限与注入范围过宽（`<all_urls>` + 全局 content script）。
  2. 敏感凭证（API Key）以明文方式存储。
  3. 导入数据到自动访问链路中缺少统一 URL 协议白名单校验。
  4. 域名匹配策略使用 `includes`，存在误匹配/策略绕过风险。

---

## 发现项

### 1) 扩展权限与注入范围过宽（高）
- **位置**：`manifest.json`
- **现象**：`host_permissions` 和 `content_scripts.matches` 都使用了 `<all_urls>`。
- **风险**：
  - 扩展在几乎所有页面都具备注入能力和访问能力，攻击面显著扩大。
  - 一旦扩展内部后续出现 XSS/消息注入链路，可被放大为“全站读取/操作”。
- **建议**：
  - 将 `host_permissions` 收敛到业务必需域名；或改为按需申请（`optional_host_permissions` + 用户触发授权）。
  - `content_scripts.matches` 改成最小集合，必要时采用 `chrome.scripting.executeScript` 按需注入。

### 2) API Key 明文存储于本地设置（高）
- **位置**：`popup/popup.js` + `lib/db.js`
- **现象**：`geminiApiKey` 通过 `setSetting/getSetting` 直接存取。
- **风险**：
  - 本机被攻陷、恶意扩展联动或调试导出数据时，凭证可能泄露。
  - 凭证泄露可直接导致第三方 API 额度/账单风险。
- **建议**：
  - 至少在 UI 层支持“不持久化，仅会话使用”。
  - 存储时增加本地加密层（基于用户主密码派生密钥），并提供“锁定/解锁”状态。
  - 增加 API Key 最小权限说明与一键清除入口。

### 3) Excel 导入 URL 缺少统一协议校验（中）
- **位置**：`lib/filter.js`（`parseRow`）→ `popup/popup.js` 发布/分析流程
- **现象**：从 Excel 读入的 `sourceUrl` 直接进入后续流程；粘贴 URL 导入有 `http/https` 校验，但 Excel 路径缺少同等约束。
- **风险**：
  - 非预期 scheme（如 `file:`、`data:`、`javascript:`）可能进入数据层并在后续流程触发异常或边界行为。
- **建议**：
  - 在 `parseRow` 后统一做 URL 规范化与协议白名单校验（仅 `http/https`）。
  - 对不合法 URL 打标并在导入阶段拦截。

### 4) 域名黑白名单匹配使用 includes（中）
- **位置**：`lib/filter.js`
- **现象**：`domainBlacklist/domainWhitelist` 使用 `sourceDomain.includes(xxx)`。
- **风险**：
  - 误伤：`goodexample.com` 可能误匹配 `example.com` 规则。
  - 绕过：攻击者可构造带有子串的域名干扰策略判断。
- **建议**：
  - 使用“完全域名匹配 + 子域匹配”规则：`host === rule || host.endsWith('.' + rule)`。
  - 导入规则时统一做 punycode/小写归一化。

### 5) 失败日志可能包含页面结构与业务元数据（中）
- **位置**：`background.js`（`captureFormSnippet`）+ `popup/popup.js`（失败日志导出）
- **现象**：失败时可记录表单 HTML 片段、页面分析信息并导出 JSON。
- **风险**：
  - 若日志在团队内传播，可能暴露目标站结构特征、策略信息及操作痕迹。
- **建议**：
  - 默认关闭详细采集；仅在调试开关开启时采样。
  - 导出前提供字段脱敏（URL query、邮箱、本地 profile 名称）。

---

## 优先级修复计划（建议）

### P0（本周）
1. 收敛权限与注入范围（问题 #1）。
2. API Key 安全策略升级（问题 #2）。

### P1（下周）
3. Excel 导入 URL 统一白名单校验（问题 #3）。
4. 域名匹配逻辑改为精确/子域规则（问题 #4）。

### P2（迭代）
5. 失败日志脱敏与最小化采集（问题 #5）。

---

## 快速自检清单

- [ ] Manifest 权限是否仅覆盖最小业务域名。
- [ ] 所有 URL 输入路径是否统一经过 `http/https` 白名单校验。
- [ ] 凭证是否支持会话态、加密存储与一键清理。
- [ ] 域名规则是否采用“精确 + 子域”匹配而非子串匹配。
- [ ] 导出日志是否默认脱敏并可配置采集级别。

