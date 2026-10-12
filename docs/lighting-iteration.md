# L1 光照迭代

2026-10-12，基于 C2 `3ebf10424e232ba372c161aad1519c98c61489fc`。保留 M1 / D1 / C1 / P1 / A1 / V1 / Q1 / T1 / B1 / C2。技术检查、独立内部效果与用户认可分开记录。

## 实际定位与改动

真实 Three.js C2 主场及剑盾近景中，米白衣袍、地面与铁甲同时偏黄绿；受光面与暗面不易读出各材质原色。现有两光分别使用暖黄天空、橄榄地面、暖黄主光，参数会共同偏移颜色；这是实际截图支持的视觉判断，不将未启用 tone mapping 本身称为故障。

唯一候选只调整原两光的颜色与强度：Hemisphere sky `#fff5da` → `#f4f6ff`、ground `#556547` → `#62695b`、1.7 → 1.45；Directional `#fff0cb` → `#fff5e8`、2.0 → 1.8。保留暖日光识别，降低通体黄色覆盖，使米白与铁灰更清楚。日光位置(-16,28,16)、阴影范围 / 分辨率 / normalBias、背景 / fog、outputColorSpace与原 tone mapping 全保持；不新增光、后处理或材质改动。

L1 opt-in `light=candidate`；`light=baseline` 或删除light恢复原光。切换放现有镜头按钮行，双版本布局相同。所有16 GLB、材质、单位数量 / 根位置 / scale、规则、地形及C2相机固定。无query默认仍原光。

## 实测预览与对照

http://127.0.0.1:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate&ride=candidate&coordination=candidate&terrain=candidate&building=candidate&camera=candidate&light=candidate

底部“光照基准 / 光照候选 L1”只切换light并保留其他参数。正式静态截图：1280×900页面、1280×695画布、同C2 position / focus / FOV38、同32人位置、所有人Idle0。近景显式capture-only helper隐藏其余单位和塔，仅同红方index3剑盾为主体，同方向 / distance10 / focus相对root高1.1；两版相同设置。正常游戏从不调用冻结或solo helper。B1的default / near固定对照另验证原43 / 18相机不变。

- 默认：[基准](visual-iteration/lighting1/baseline-initial.png) / [L1](visual-iteration/lighting1/candidate-initial.png)
- 剑盾近景：[基准](visual-iteration/lighting1/baseline-infantry-near.png) / [L1](visual-iteration/lighting1/candidate-infantry-near.png)
- 约8秒动态：[基准](visual-iteration/lighting1/baseline-fighting-4.png) / [L1](visual-iteration/lighting1/candidate-fighting-4.png)
- 建筑近景：[基准](visual-iteration/lighting1/baseline-compatible-b1-near.png) / [L1](visual-iteration/lighting1/candidate-compatible-b1-near.png)

## 验证与边界

两版各98实际检查通过、浏览器errors=[]、每次5个GLB HTTP200。正常32人完成7次约2秒等待间隔的连续实拍及WebM，最终elapsed分别15.784 / 15.118秒、两版26活人；reset均恢复32人全血。实际鼠标同兵选择 / 原点移动、±4 / wheel2.3 / 看选中18 / overview / reset正常，QA four / sixteen保持21 / 31m、B1固定default / near保持43 / 18m。四组静态metadata严格配对：camera / canvas / 单位root及scale / 材质 / background / tone mapping / outputColorSpace / shadow参数相同。正常动态按真实时钟采样，非逐帧同源模拟，不把战果差异称为灯光改了规则。原录像只保留`.omc/evidence/lighting1/`，精选PNG与机器summary提交。

可见改善以减黄色覆盖为主；原强方向阴影、简洁材质、地形绿色与低面数轮廓保持，不宣称重做全部场景视觉。没有目标设备容量测试。最终全量780/780退出0、build退出0，独立只读源码及实拍图复审限定APPROVE：当前1280×900固定场景、所记录交互与约15秒模拟采样，无新增过曝或阴影异常。自检与独立复审查看initial / solo近景 / 约8秒和末态 / reset PNG；未宣称完整播放WebM或所有动态无风险。用户明确认可未知。测试通过不代表美术通过。当前用户明确授权适当本地commit及push，仅推既有codex工作分支，不merge main；实际Git结果由总控回读后记录。下一步仅完成[共享模拟只读差异审计](shared-simulation-audit.md)，建议首次提取2D箭更新中的逻辑；尚未实施该提取。
