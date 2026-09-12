#!/usr/bin/env python3
"""
动画帧生成器：把单帧兵种贴图做「剪纸木偶」分层变形，烘出多帧行走/攻击 spritesheet。

原理：
- 腿部分区（hip 以下）：左右两条腿沿相反方向逐行错位（越靠脚错位越大）→ 交错迈步
- 躯干分区（hip 以上）：绕髋部枢轴小角度旋转 → 挥砍蓄力/劈砍、突刺、拉弓
- 骑兵：马腿交错 + 骑手上下颠簸 → 奔驰循环

输出：assets/units/anim/<unit>_<clip>.png（横排帧条）并回写 manifest.js 的 anims 段。
"""
import json
import math
import os
import re
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'units')
OUT = os.path.join(SRC, 'anim')
MANIFEST = os.path.join(ROOT, 'assets', 'manifest.js')

ALPHA_T = 60          # 不透明阈值
BASE_Y = 154          # 脚底基线（全素材统一）
HIP_CUT = 6           # 躯干/腿分区重叠行数
PAD = 12              # 每帧左右留白（容纳摆动/旋转）

# 每兵种动画参数（素材默认朝右；蓝方运行时水平翻转，帧通用）
PARAMS = {
    'infantry': dict(hip=112, amp=4.2, walk_bob=1),
    'pikeman':  dict(hip=111, amp=3.6, walk_bob=1),
    'archer':   dict(hip=113, amp=3.6, walk_bob=1),
    'cavalry':  dict(hip=121, amp=5.6, walk_bob=2),
}

# 动画剪辑定义：每帧 (legSign, bodyAngleDeg, shiftX, bobY)
#   legSign  — 腿部交错方向（0=并拢站立）
#   bodyAngle— 躯干绕髋旋转（正=后仰蓄力，负=前倾劈砍；素材朝右）
#   shiftX   — 躯干水平位移（正=向前）
#   bobY     — 躯干垂直位移（正=下沉）
CLIPS = {
    'infantry': {
        'walk':   [(0, 0, 0, 0), (1, 0, 0, 1), (0, 0, 0, 0), (-1, 0, 0, 1)],
        'attack': [(0, 10, -1, 0), (1, -18, 2, 0), (1, -7, 1, 0), (0, 0, 0, 0)],
    },
    'pikeman': {
        'walk':   [(0, 0, 0, 0), (1, 0, 0, 1), (0, 0, 0, 0), (-1, 0, 0, 1)],
        'attack': [(0, 6, -2, 0), (1, -3, 4, 0), (1, 0, 2, 0), (0, 0, 0, 0)],
    },
    'archer': {
        'walk':   [(0, 0, 0, 0), (1, 0, 0, 1), (0, 0, 0, 0), (-1, 0, 0, 1)],
        'attack': [(0, 8, -1, 0), (0, -3, 1, 0), (0, 0, 0, 0)],
    },
    'cavalry': {
        'walk':   [(0, 0, 0, 0), (1, 0, 0, -2), (0, 0, 0, 0), (-1, 0, 0, -2)],
        'attack': [(0, 0, -1, 0), (0, -3, 3, 0), (0, 0, 0, 0)],
    },
}


def bbox_of(im):
    px = im.load()
    w, h = im.size
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > ALPHA_T:
                xs.append(x); ys.append(y)
    return min(xs), max(xs), min(ys), max(ys)


def leg_split_x(im, hip):
    """腿部区域不透明像素的加权中线 → 左右腿分界。"""
    px = im.load()
    w, h = im.size
    tot, wsum = 0, 0
    for y in range(int(hip) + 8, BASE_Y - 2):
        for x in range(w):
            if px[x, y][3] > ALPHA_T:
                tot += 1
                wsum += x
    return wsum / max(1, tot)


def make_frame(src, P, legSign, angle, shiftX, bobY):
    """组装单帧：腿部逐行错位 + 躯干绕枢轴旋转。"""
    w, h = src.size
    hip = P['hip']
    hipcut = int(hip) + HIP_CUT
    FW = w + PAD * 2

    x0, x1, _, _ = bbox_of(src)
    cx = (x0 + x1) / 2.0            # 注册中心：帧内水平居中
    splitx = leg_split_x(src, hip)  # 左右腿分界
    off_x = round(FW / 2 - cx)      # 让 cx 精确落在帧中心

    frame = Image.new('RGBA', (FW, h), (0, 0, 0, 0))

    # ---- 下半身（含腿）：逐行水平错位，越靠脚幅度越大 ----
    lower = src.crop((0, hipcut, w, h)).load()
    fpx = frame.load()
    for y in range(hipcut, h):
        t = (y - hip) / max(1.0, (BASE_Y - hip))
        t = max(0.0, min(1.15, t))
        for x in range(w):
            a = lower[x, y - hipcut][3]
            if a <= ALPHA_T:
                continue
            side = 1 if x < splitx else -1
            dx = round(legSign * P['amp'] * t * side)
            tx = off_x + x + dx
            if 0 <= tx < FW:
                fpx[tx, y] = lower[x, y - hipcut]

    # ---- 上半身：绕 (splitx, hipcut) 枢轴旋转 ----
    upper = src.crop((0, 0, w, hipcut))
    if abs(angle) < 0.3 and shiftX == 0 and bobY == 0:
        rot, rox, roy = upper, 0, 0
        piv_rx, piv_ry = splitx, hipcut
    else:
        rot = upper.rotate(angle, resample=Image.NEAREST, expand=True)
        rw, rh = rot.size
        # 枢轴经旋转后的映射（y-down 坐标，正角=视觉逆时针）
        th = math.radians(angle)
        vx, vy = splitx - w / 2.0, hipcut / 2.0
        mvx = math.cos(th) * vx + math.sin(th) * vy
        mvy = -math.sin(th) * vx + math.cos(th) * vy
        piv_rx, piv_ry = rw / 2.0 + mvx, rh / 2.0 + mvy
        rox = roy = 0
    # 目标枢轴位置（帧坐标系）
    tpx = off_x + splitx + shiftX
    tpy = hipcut + bobY
    frame.paste(rot, (round(tpx - piv_rx), round(tpy - piv_ry)), rot)
    return frame


def build_unit(name):
    src = Image.open(os.path.join(SRC, name + '.png')).convert('RGBA')
    utype = name.split('_', 1)[1]
    P = PARAMS[utype]
    out = {}
    for clip, frames in CLIPS[utype].items():
        imgs = [make_frame(src, P, *f) for f in frames]
        FW, H = imgs[0].size
        strip = Image.new('RGBA', (FW * len(imgs), H), (0, 0, 0, 0))
        for i, im in enumerate(imgs):
            strip.paste(im, (i * FW, 0))
        fn = f'{name}_{clip}.png'
        strip.save(os.path.join(OUT, fn))
        out[clip] = {'file': f'anim/{fn}', 'fw': FW, 'fh': H, 'frames': len(imgs)}
    return out


def update_manifest(anims):
    """整体重建 manifest.js（数据源：manifest.json + 本脚本生成的 anims）。"""
    import json as _json
    with open(MANIFEST.replace('.js', '.json'), encoding='utf-8') as f:
        data = _json.load(f)
    data['anims'] = anims
    content = '// 素材清单（由处理脚本生成；anims 段由 gen_animations.py 维护）\n'
    content += 'const MANIFEST = ' + _json.dumps(data, ensure_ascii=False, indent=2) + ';\n'
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        f.write(content)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    anims = {}
    for f in sorted(os.listdir(SRC)):
        if f.endswith('.png') and '_' in f:
            name = f[:-4]
            anims[name] = build_unit(name)
            clips = ', '.join(f'{c}x{d["frames"]}' for c, d in anims[name].items())
            print(f'  {name}: {clips}')
    update_manifest(anims)
    print('manifest.js 已更新')
