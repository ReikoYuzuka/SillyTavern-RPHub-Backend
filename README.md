# SillyTavern-RPHub-Backend

SillyTavern 插件：RP-Hub 角色卡兼容后端。负责角色卡的嗅探、解析、规范化存储与查询，为 RegexPlus 正则引擎与 RP助手 前端提供数据接口。

**安装**：把本目录放进 `SillyTavern/plugins/`，重启 SillyTavern（路由自动挂载到 `/api/plugins/rp-hub-compat`）。

## 接口列表

基址：`/api/plugins/rp-hub-compat/v1`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/cards/upload` | 上传角色卡：嗅探→解析→规范化→落盘→映射；`?writeBack=1` 可写回 ST 标准卡 |
| POST | `/cards/analyze` | 卡面判断（不落盘） |
| GET | `/status` | 插件状态（版本 / 卡数 / 运行时长） |
| GET | `/cards/{cardId}` | 全部规范化数据 |
| GET | `/cards/{cardId}/character` | 角色信息 |
| GET | `/cards/{cardId}/regex` | 正则脚本 |
| GET | `/cards/{cardId}/lorebook` | 世界书条目 |
| GET | `/cards/{cardId}/variables` | 变量 / uiTemplates |
| GET | `/cards/{cardId}/mapping` | 字段映射 |
| GET | `/cards/{cardId}/raw` | 原始数据（blocks + 原始 JSON） |
| GET | `/cards/by-name/:name` | 按角色名查卡（供前端模式判定） |
| GET | `/cards/exists/:contentHash` | 导入去重预检 |
| GET | `/marks` | 标记列表 |
| GET / PUT / DELETE | `/marks/:contentHash` | 单卡标记（强制 rphub 类型） |

通用参数：`?fields=a,b,c` 字段裁剪、`?offset=&limit=` 分页；GET 视图带 ETag（304 缓存）。