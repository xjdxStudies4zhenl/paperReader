# models/（打包内置模型用）

这个目录**故意留空**：模型体积大，不进 git，也不默认打进安装包。

三种用法，按需选一种：

## 1. 不内置（默认，推荐）

安装包里没有模型，应用首次划词翻译时会提示，用户自己下载：

```bash
npm run model:download          # 默认 Q4_K_M（1.08GB）
```

模型落在 `%APPDATA%\paper-reader\models\`（其他平台对应用户配置目录），
这也是 `electron/llm/model-registry.js` 的首选查找位置。

## 2. 内置进安装包

把 GGUF 拷到这个目录，`electron-builder.yml` 里的 `extraResources` 会把它原样带到
`resources/models/`（asar 之外，运行时用 `process.resourcesPath` 找到）：

```bash
npm run model:stage             # 从 userData/models 复制默认模型到 ./models
npm run dist:win                # 然后正常打包
# 或一步到位
npm run dist:win:with-model
```

注意体积代价：Q4_K_M 约 1.08GB，NSIS 安装包会因此膨胀到 1GB+。

## 3. 只打极致量化版

```bash
npm run model:stage -- 1.25bit  # 440MB
npm run dist:win
```

> 目前 node-llama-cpp 3.22.2 自带的 llama.cpp 读不了 1.25bit 的 GGUF（tensor offset 校验失败），
> 只有等推理后端更新后这个变体才有实用价值，细节见 README「已知问题」。

## 别提交模型

`../.gitignore` 已忽略 `models/*.gguf`，保持仓库干净。
