## **Broadseek** 宽度求索

这是一个第三方 Deepseek 客户端，实现了一些官方基本功能的同时增强了对话分支查找

> PS：  
> 之所以做这个是因为自己在对话分支里迷路了好久...  
> 为什么是“宽度求索”？ 因为分支树字面上看起来很宽，找起来好麻烦

## 构建

本项目使用 pnpm 管理构建流程

首先确保 Node 依赖安装

```bash
pnpm install
```

另外，若要构建安卓版本，还需要保证安卓开发工具链已经配置好

### 网页端

```bash
pnpm build # 构建 Web 版本
pnpm dev   # 启动本地服务
```

### 安卓端

```bash
pnpm build:android # 完整流程
pnpm sync:android  # 跳过 Web 构建
```

> 注：不会自动生成签名

## 致谢

[DS-Free-API](https://github.com/NIyueeE/ds-free-api) 提供了 Deepseek 客户端的 API 接口与用法参考  
[DS Enhance](https://github.com/calendar0917/DeepseekWeb-enhance) 提供了制作灵感与代码参考
