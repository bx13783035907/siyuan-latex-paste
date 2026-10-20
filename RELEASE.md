# 发布到思源集市

集市只做一件事：从你仓库的 **Latest Release** 里下载 `package.zip`。所以整个流程的核心是「让每次发版都产出一个合规的 package.zip」，`.github/workflows/release.yml` 已经把这步自动化了。

## 一次性准备

### 1. 建仓库

- 仓库名**必须**是 `siyuan-latex-paste`（与 `plugin.json` 的 `name` 完全一致，集市靠这个匹配）
- 默认分支**必须**是 `main`
- 仓库需要公开

```bash
git init -b main
git add .
git commit -m "feat: 初版"
git remote add origin https://github.com/<你的用户名>/siyuan-latex-paste.git
git push -u origin main
```

### 2. 改掉占位地址

`plugin.json` 里的 `url` 和 `author` 现在是占位的，换成真实的：

```json
"author": "你的名字",
"url": "https://github.com/你的用户名/siyuan-latex-paste",
```

### 3. 确认这几项

| 项 | 要求 | 当前 |
| --- | --- | --- |
| `name` | 与仓库名一致，且集市内不重名 | `siyuan-latex-paste` |
| `version` | semver，且与 release tag 对应 | `0.2.8` |
| `minAppVersion` | 用到的 API 的最低版本 | `3.1.0` |
| `icon` | ≤ 64 KiB，建议 160×160 | 160×160，9 KB |
| `preview` | ≤ 512 KiB，建议 1024×768 | 1024×768，9 KB |
| `index.css` | **必须存在**（哪怕没样式） | 已补 |
| `displayName` / `description` / `readme` | 必须有 `default`，其他语言用 BCP 47（`zh-CN` 而不是 `zh_CN`） | 已改 |
| README | 中英各一份 | `README.md` / `README.zh-CN.md` |

> 注意 `i18n/` 目录下的文件名仍然是 `zh_CN.json`（下划线），这是思源自己 i18n 的约定；而 `plugin.json` 里的语言键要用 `zh-CN`（连字符）。两者不一样，别改错。

## 发第一个版本

```bash
git tag v0.2.8
git push origin v0.2.8
```

tag 一推，`release.yml` 就会跑：装依赖 → 类型检查 → 66 个测试 → 构建 → 打 `package.zip` → 校验里面确实有 `index.js`、`index.css`、`plugin.json` → 发 Release。

去 Actions 页面确认跑绿了，再去 Releases 看有没有 `package.zip` 附件。

## 提交到集市

1. Fork [siyuan-note/bazaar](https://github.com/siyuan-note/bazaar)
2. 在仓库根目录的 `plugins.txt` 里加一行（**只加一行，不要加逗号或空行**）：

   ```
   你的用户名/siyuan-latex-paste
   ```

3. 向 `main` 分支开 PR

PR 会自动跑 `PR Check`，检查 release 是否存在、`package.zip` 是否合规、metadata 字段是否齐全。挂了就按提示改**同一流水线里的东西**，然后等定时任务自动重跑（约 20 分钟一次），**不要新开 PR**。

合并后几分钟内集市索引就更新了，思源里**重启一次**才能刷到。

## 后续更新

不用再提 PR。改版本号、打 tag、推上去就行：

```bash
# 1. 同步两处版本号
#    plugin.json 的 version
#    package.json 的 version
# 2. 打 tag
git tag v0.2.9
git push origin v0.2.9
```

集市每 1~3 小时拉一次索引。发布后 1~3 小时内用户就能在集市里看到更新。

## 容易踩的坑

- **仓库名和 `name` 不一致** —— 最常见，直接 PR Check 失败。
- **忘了升 `version`** —— 集市认为没有新版本，索引不更新。
- **`package.zip` 里少了 `index.css`** —— 硬性要求，缺了必挂。
- **`icon.png` 超过 64 KiB 或尺寸不是正方形** —— 集市展示会出问题。
- **`plugin.json` 里写 `zh_CN`** —— 必须 BCP 47 的 `zh-CN`。
- **`.env` 提交上去了** —— 里面有你的本地工作区路径，`.gitignore` 已经挡住，提交前 `git status` 扫一眼。

## 关于构建产物

`dist/` 在 `.gitignore` 里，不入库。CI 每次现场构建，产物只进 `package.zip`。这样做的好处是仓库里只有源码，diff 干净。
