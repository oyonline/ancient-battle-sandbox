#!/usr/bin/env python3
"""量出各兵种的“接地基准”与“逐帧对齐补偿”，打印可直接粘进 js/game.js 的两张表。

用法：
    python3 tools/measure_foot.py

背景（三个坑）：
1) 底部留白不一致：AI 出图每张“贴图底边→脚底”的空白从 13px 到 35px 不等，
   把贴图底边当脚底，角色就悬在影子上方 → 飘。
   注意骑兵是奔姿，四条腿里只有一条落地，所以“脚底”要取最低的实质内容行，
   不能取“最宽的一行”（那样会落在另外三条抬起的腿的高度上，差 16px）。
2) 站位不一致：同一套动画的 4 帧，角色在画布里的位置互相差最多 41px，直接播就会左右抖。
   这里用“与站姿做一维投影相关”求出每帧的最佳位移，作为逐帧补正。
3) 脚掌横向位置不一致：影子要压在脚掌下面，所以量出脚掌带（落地最低点往上若干行）的
   横向中心。人类靴子只占底部 6~8 行，马四条腿铺开 20 行，故按兵种给带宽 FOOT_WIN。

输出：
    FOOT       接地基准（pad 脚底留白 / dx 脚掌横向偏移 / w,h 影子尺寸）
    ANIM_ALIGN 逐帧对齐补正 [dx, dy]（源图像素，站姿为 0）
"""
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNITS_DIR = os.path.join(ROOT, 'assets', 'units')
MANIFEST = os.path.join(ROOT, 'assets', 'manifest.json')

TYPES = ['infantry', 'pikeman', 'archer', 'cavalry']

ALPHA_THR = 40       # 低于该 alpha 视为透明
MIN_PX = 3           # “实质内容行”至少这么多像素，滤掉零星噪点
CANVAS_W = 256       # 对齐用的公共画布（按底边中心摆放，与游戏锚点一致）
CANVAS_H = 256
MAX_SX, MAX_SY = 60, 30   # 对齐搜索范围（源图像素）
ALIGN_FRAC = 1.0     # 参与对齐的内容高度比例（1=全身；试过只取下半身，
                     #   但长枪兵/弓箭手的腿被长枪、弓身遮住，反而对不准）
ATTACK_DY_ZERO = True   # 攻击帧只取横向补正：挥砍让重心大幅上下移动，
                        #   纵向对齐不可靠（帧间重合度只有 0.57~0.83）

# 脚掌带高度：要刚好框住“落地的那几处接触点”
FOOT_WIN = {'infantry': 8, 'pikeman': 6, 'archer': 8, 'cavalry': 20}
SPAN_K = {'infantry': 3.0, 'pikeman': 3.7, 'archer': 3.2, 'cavalry': 0.96}  # 影宽/脚掌跨度
ASPECT = 2.04        # 等距视角影子宽高比


def mask(path, frame=None):
    im = Image.open(path).convert('RGBA')
    if frame is not None:
        fw, fh, i = frame
        im = im.crop((i * fw, 0, (i + 1) * fw, fh))
    a = np.array(im)[:, :, 3].astype(float)
    a[a < ALPHA_THR] = 0
    return a


def to_canvas(a, keep_bottom=None):
    """按“底边中心”摆到公共画布上（= 游戏里 origin(0.5,1) 的锚点）

    keep_bottom 只保留最下面这么多行：对齐只看下半身，避免挥剑、披风这些
    帧间摆动巨大的部位把对齐带偏（它们不影响“站得稳不稳”）。
    """
    c = np.zeros((CANVAS_H, CANVAS_W))
    h, w = a.shape
    ox = (CANVAS_W - w) // 2
    oy = CANVAS_H - h
    c[oy:oy + h, ox:ox + w] = a
    if not keep_bottom:
        return c
    return c[CANVAS_H - keep_bottom:]


def best_shift_1d(ref, cur):
    """一维投影相关，求把 cur 挪多少能对上 ref（返回 dx, dy）"""
    out = []
    for axis in (0, 1):          # 0: 求 x 位移(列投影)  1: 求 y 位移(行投影)
        r = ref.sum(axis=axis)
        f = cur.sum(axis=axis)
        rng = range(-MAX_SX, MAX_SX + 1) if axis == 0 else range(-MAX_SY, MAX_SY + 1)
        best, bv = 0, -1.0
        for s in rng:
            v = np.minimum(r, np.roll(f, s)).sum()
            if v > bv:
                bv, best = v, s
        out.append(best)
    return out[0], out[1]


def ground_rows(al):
    """最低实质内容行 / 每列落地最深行"""
    h, w = al.shape
    row_n = (al > 0).sum(axis=1)
    low = max(y for y in range(h) if row_n[y] >= MIN_PX)
    bot = np.full(w, -1)
    for x in range(w):
        col = np.nonzero(al[:, x])[0]
        if len(col):
            bot[x] = col.max()
    return low, bot


def main():
    static = {}
    for t in TYPES:
        path = os.path.join(UNITS_DIR, f'red_{t}.png')
        al = mask(path)
        h, w = al.shape
        low, bot = ground_rows(al)

        band = bot >= (low - FOOT_WIN[t])
        xs = np.nonzero(band)[0]
        span = int(xs.max() - xs.min() + 1)
        foot_cx = (xs.min() + xs.max()) / 2

        rows = np.nonzero((al > 0).sum(axis=1))[0]
        keep = int((rows.max() - rows.min() + 1) * ALIGN_FRAC)     # 只看下半身

        sw = int(round(span * SPAN_K[t]))
        static[t] = {
            'canvas': to_canvas(al, keep),
            'keep': keep,
            'row': {
                'pad': h - 1 - low,
                'dx': int(round(foot_cx - (w - 1) / 2)),
                'w': sw, 'h': int(round(sw / ASPECT)),
            },
        }
        r = static[t]['row']
        print(f'{t:9s} pad={r["pad"]:3d} dx={r["dx"]:+4d} 脚掌跨度={span:3d}(带{FOOT_WIN[t]}行) '
              f'→ w={r["w"]:3d} h={r["h"]:3d}  对齐用下半身={keep}行')

    man = json.load(open(MANIFEST))['anims']
    aligns = {}
    print('\n逐帧对齐补正（正数=向右/向下补；括号内为与站姿的重合度）：')
    for t in TYPES:
        entry = man.get(f'red_{t}')
        if not entry:
            continue
        ref = static[t]['canvas']
        keep = static[t]['keep']
        aligns[t] = {}
        for kind, d in entry.items():
            per, quality = [], []
            for i in range(d['frames']):
                cur = to_canvas(mask(os.path.join(UNITS_DIR, d['file']), (d['fw'], d['fh'], i)), keep)
                dx, dy = best_shift_1d(ref, cur)
                if kind == 'attack' and ATTACK_DY_ZERO:
                    dy = 0
                ov = min(ref.sum(), cur.sum())
                hit = np.minimum(ref, np.roll(np.roll(cur, dx, axis=1), dy, axis=0)).sum()
                per.append([dx, dy])
                quality.append(round(float(hit / ov), 2))
            aligns[t][kind] = per
            print(f'  {t:9s}{kind:7s} {per}  {quality}')

    print('\n---- 第 1 张表（贴到 js/game.js 的 FOOT） ----')
    print('const FOOT = {')
    for i, t in enumerate(TYPES):
        r = static[t]['row']
        print(f"    {t + ':':10s}{{ pad: {r['pad']:2d}, dx: {r['dx']:3d}, w: {r['w']:2d}, h: {r['h']:2d} }}"
              f"{',' if i < len(TYPES) - 1 else ''}")
    print('};')

    print('\n---- 第 2 张表（贴到 js/game.js 的 ANIM_ALIGN） ----')
    print('const ANIM_ALIGN = {')
    for i, t in enumerate(TYPES):
        clips = ', '.join(f'{k}: {json.dumps(v)}' for k, v in aligns[t].items())
        print(f"    {t + ':':10s}{{ {clips} }}{',' if i < len(TYPES) - 1 else ''}")
    print('};')


if __name__ == '__main__':
    main()
