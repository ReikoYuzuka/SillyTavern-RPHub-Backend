// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// rp-hub-compat 插件入口
//
// 契约（SillyTavern 1.18.0 plugin-loader.js）：
//   info: { id, name, description }  id 匹配 /^[a-z0-9_-]+$/
//   init(router): 异步可选，接收 express.Router() 实例
//   exit(): 可选清理
//
// ST 自动挂载 app.use('/api/plugins/rp-hub-compat', router)。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsPromises from 'node:fs/promises';
import { registerRoutes } from './lib/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const info = {
    id: 'rp-hub-compat',
    name: 'RP-Hub Compat Plugin',
    description: 'RP-Hub 角色卡兼容插件（第一部：格式解析、规范化存储、查询 API）',
};

export async function init(router) {
    const dataDir = path.join(__dirname, 'data');
    await fsPromises.mkdir(dataDir, { recursive: true });
    globalThis.__rphubStartedAt = Date.now();
    registerRoutes(router, { dataDir });
}

export async function exit() {
    // 无长期资源，无需清理
}
