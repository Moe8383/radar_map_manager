# Radar Map Manager (RMM)

![Logo](logo.png)

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)

> 🇺🇸 [English Documentation](README.md) | 🇨🇳 **中文文档**

**Radar Map Manager (RMM)** 是专为 Home Assistant 打造的毫米波雷达可视化与数据融合集成。

它不仅仅是一个户型图卡片，更是一个**空间感知引擎**。RMM 能将家中分散的多个毫米波雷达的数据统一映射到您的一个或多个户型图上，实现全屋人员定位追踪、轨迹可视化以及基于精确坐标的自动化触发。

> 🚀 **V1.2 重磅升级！** 带来史诗级的性能与安全进化！全新引入 **10Hz 内存级流媒体总线 (Zero I/O)** 彻底告别数据库膨胀；加入 **零信任安全架构**；并支持 RMM 专属雷达（即将推出）的**硬件级多边形区域**同步；增加 **入口区域** 和 **静止驻留区** 多重保险防止误触发和静止目标消失。

---

## ✨ 核心功能

### 1. 🎯 所见即所得的可视化编辑器
抛弃繁琐的 YAML 坐标计算！RMM 提供了一个交互式的前端编辑器：
* **配置/展示双模式**：支持**配置模式 (config)** 和 **展示模式 (read_only)** 两种模式，配置、展示两不误。
* **自动发现雷达**：支持自动扫描局域网内的雷达设备，轻松添加。
* **多户型/楼层支持**：支持**多户型（map_group）** 轻松管理多个楼层和地点，为你的家庭、办公室设置独立的视图。
* **灵活自由的雷达配置**：直接在户型图上拖拽雷达位置，支持雷达的旋转、缩放和镜像翻转，一站式管理雷达。
* **自动定位缩放**：通过freeze功能，可以可视化的定位雷达目标在户型图上的相对位置，让你轻松调整雷达缩放，告别忙猜。
* **雷达安装方式支持**：完美支持 **侧装 (Side Mount)** 和 **顶装 (Ceiling Mount)** 雷达。

### 2. 🌐 多雷达数据融合 (Sensor Fusion)
RMM 的目标融合引擎能将多个雷达的目标点统一到一个坐标系中：
* **自动聚类**：当多个雷达探测到同一个人时，自动合并为一个目标，避免“影分身”，融合范围支持自定义。
* **盲区互补**：通过多雷达叠加，消除房间内的探测死角。
* **轨迹平滑**：内置10级目标轨迹平滑处理，拒绝卡顿、跳跃。

### 3. 🛡️ 灵活的区域管理 (Zones Manager)
支持绘制任意形状的多边形区域，灵活的编辑方式让你轻松管理：
* **雷达监测区 (`Monitor Zones`)**：为每个雷达单独设置监测区，只有进入该区域才会触发该雷达的目标融合与显示；如果不设置则默认全局融合。
* **全局监测区 (`Detect Trigger`)**：**自动化神器！** 在户型图上自由设置监测区，当融合目标进入该区域后，会触发 HA 的实体（自动生成）。
    * 支持自定义 **触发延迟 (Delay)**，有效避免误报。
* **全局排除区 (`Detect Exclude`)**：**解决误报的神器！** 在地图上圈出风扇、窗帘或绿植的位置，将其设为“排除区”，引擎会自动过滤掉该区域内的所有干扰信号。
* **入口区域 (`Entrance Zones`)**：**绿色通道，防误报双保险！** 诞生在此区域内的任何新目标，都会被系统无条件信任并瞬间转正，无需等待验证延迟，实现零延迟的“有人”状态上报。
    * 建议画在房间的真实门框位置
* **静止驻留区(`Stationary Hold`)**：**专治“人在灯灭”的终极防线** 针对深度睡眠、阅读、如厕等微动极小的场景，当雷达在此区域内短暂丢失信号时，系统会在原地锁定一个“驻留锚点”，在倒计时结束前持续向智能家居汇报“有人”状态。
* **独立延时 (`Dly`)**：可为每件家具定制专属容忍时间（秒）。在绘制时通过顶部 `Dly` 填入秒数（留空或0则默认使用系统全局的 `S_Hold` 时间）。
  * *大床 (深度睡眠)*：设为 3600（1小时），盖厚被子一动不动也能安心睡到天亮。
  * *沙发 (专注观影)*：设为 600（10分钟），兼顾沉浸体验与起身后自动关灯。
  * *马桶/浴缸 (卫浴保护)*：设为 300（5分钟），告别洗澡上厕所需要尴尬挥手。
* **硬件级区域设置 (`Hardware Zones`)**：(仅限RMM专属雷达，即将推出) 直接在 HA 户型图上灵活绘制雷达硬件级检测/过滤区域，从物理层面上掐断干扰源！与全局区域完美互补！
* **自动化实体**：每个全局监测区都会自动生成 **存在实体 (`binary_sensor`)** 和 **人数实体 (`sensor`)**，让您轻松实现自动化。
    * *场景举例*：“人坐在沙发上自动打开电视”、“人走进浴室区域自动调节灯光”。


### 4. 📐 3D 空间修正
针对侧装雷达，RMM 内置了 3D 修正算法。根据雷达安装高度和目标高度，自动将斜距 (Slant Range) 还原为地距 (Ground Distance)，大幅提高定位精度。

---

### 5. ⚡ 内存级高速数据总线 (Zero I/O)
为了彻底保护 HA 数据库 (Recorder) 和树莓派 SD 卡寿命，RMM V1.1 实现了 UI 与自动化的彻底分离。
高达 10Hz 的雷达目标，不再作为实体写入 HA 状态机，而是通过 **内存级隧道** 直连前端卡片。**让你获得 60FPS 满血电竞级丝滑画面的同时，对 HA 数据库的写入损耗降为 0！**

### 6. 🔐 零信任安全架构
RMM 专属雷达 即将全面接入，采用动态PIN码和硬件级加密，保护您的雷达设备本地安全接入HA，杜绝隐私外泄。

---

## �️ 支持的硬件

RMM 兼容所有能够接入 Home Assistant 的毫米波雷达（包括 1D/2D/3D 雷达），只要它们能提供 `DISTANCE` 或者 `X`/`Y` 坐标数据，例如 `HLK-LD2450` `LD2460` `LD6001` `LD6002b` `LD6004`

### 连接方式
* **RMM 专属雷达**  **即将推出，敬请关注**
* **ESPHome / MQTT**
* **Zigbee** (需支持坐标上报)

### ⚠️重要提示！！！

#### 坐标实体命名规范(非RMM专属雷达)
为了确保系统能正确识别雷达数据，请务必遵循以下命名格式：

1.  **1D 雷达**：
    * 格式：`sensor.[radar_name]_distance`
    * *例如：`sensor.rd_ld2410_distance`*
2.  **2D/3D 雷达**：
    * 格式：`sensor.[radar_name]_target_?_x` (包含 `_x`, `_y`, `_z`)
    * *例如：`sensor.rd_ld6004_target_1_x`*
3.  **雷达目标数 [可选]**：
    * 格式：`sensor.[radar_name]_presence_target_count`
    * *例如：`sensor.rd_ld2450_presence_target_count`*
4.  **目标坐标单位**:
    * 支持单位包括：`m` `cm` `mm`
    * 强烈建议设置单位，如果没有设置单位，默认用`m`作为单位

#### 高频实体排除设置
如果您使用的是v1.0.x版本，强烈建议在HA的configuration.yaml中增加以下配置，以减轻数据库和I/O压力

```yaml
recorder:
  exclude:
    entity_globs:
      - sensor.rmm_*_master
```
如果您已升级到v1.1.x及后续版本，可以不增加上述配置

---

## 📦 安装方法

### 方式一：HACS 自动安装 (推荐)
[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Moe8383&repository=radar_map_manager&category=integration)
1. 在 Home Assistant 左侧边栏打开 **HACS**。
2. 进入 **集成 (Integrations)**，点击右下角的 **浏览并下载存储库 (Explore & Download Repositories)**。
3. 在搜索框中输入 **"Radar Map Manager"**。
4. 点击进入详情页，并在右下角点击 **下载 (Download)**。
5. 重启 Home Assistant。

### 方式二：手动安装
1.  下载本仓库的 `custom_components/radar_map_manager` 文件夹。
2.  将其复制到您 HA 配置目录下的 `custom_components/` 中。
3.  重启 Home Assistant。

---

## ⚙️ 配置指南

### 第一步：添加集成
1.  前往 **配置** -> **设备与服务** -> **添加集成**。
2.  搜索 **Radar Map Manager** 并添加。

### 第二步：添加卡片
1.  在仪表盘点击“编辑仪表盘” -> “添加卡片”。
2.  搜索 **Radar Map Manager** 卡片。
3.  或者使用以下 YAML 配置：

**独立使用（manual-card）：**
```yaml
type: custom:radar-map-card
map_group: default                     # 可选，户型图/楼层名称，默认default
read_only: false                       # 可选，true为编辑模式，false为展示模式，默认false
bg_image: /local/floorplan/house.png   # 编辑模式下必填，户型图图片
target_radius: 5                       # 可选，融合目标大小
handle_radius: 1.5                     # 可选，区域端点大小
handle_stroke: 0.2                     # 可选，区域激活端点大小
zone_stroke: 0.5                       # 可选，区域线条粗细
label_size: 2                          # 可选，区域名称字体大小
target_colors:                         # 可选，雷达原始目标自定义颜色
  - yellow
  - "#00FFFF"
  - "#FF00FF"
```
**在picture-elements卡片中使用：**
```yaml
type: picture-elements
image: /local/floorplan/3dplan/blank_floor.png
elements:
  - type: custom:radar-map-card
    target_radius: 5
    read_only: true
    style:
      top: 50%
      left: 50%
      width: 100%
      height: 100%
      transform: translate(-50%, -50%)
      pointer-events: none
```

---

## 🪄 编辑模式使用指南

点击卡片右上角的⚙️，进入编辑模式。

![RMM](gif/open_rmm.gif)

### A. 📡 雷达布局（Layout）

点击面板中的 `Layout` 进入雷达布局模式，此时显示的目标是雷达的原始坐标（1D雷达目标用D标签显示）。

![LAYOUT](images/layout_1.png)

#### 1. 添加/删除雷达

* 添加：点击 `+` 号，直接选中扫描出的雷达，或者输入在HA中的雷达名称，如雷达的坐标为 `sensor.rd_ld2450_target_1_x`，则输入雷达名称：`rd_ld2450`

* 删除：选中已添加的雷达，点击 `-` 号，删除该雷达，慎重操作。

#### 2. 雷达设置

![LAYOUT](gif/layout_editor.gif)

* 雷达定位：拖动雷达到实际摆放的位置，拖动雷达“把手”选择角度。位置和角度可以通过面板的`X`/`Y`/`Rot`进行微调。

* 调整比例：站在雷达监测范围内（建议尽量远离中线，并尝试多个位置提高精准度），建议综合采用以下几种方法，使雷达目标与户型图吻合：

  * 方法一（推荐）：点击 `Freeze` 按钮，会锁定雷达识别的第1个目标，手动拖动该目标至你所处于的户型图位置，会自动计算缩放比例

![LAYOUT](gif/layout_freeze.gif)

  * 方法二：通过调整面板中的 `ScX` 和 `ScY` ，调整 `X`/`Y` 坐标的显示比例
  * 方法三：点击 `Ax`/`Ay` 会根据背景图比例自动调整（供参考）
  

* 安装方式：勾选面板底部的 `Ceiling` , 切换“侧装/顶装”安装方式

* 镜像模式：勾选面板底部的 `Mirror` ， 反转雷达 X 轴

* 3D矫正： 勾选面板底部的 `3D`，输入雷达安装高度（单位：米），将进行目标3D矫正。如果雷达安装高度在建议范围内，可以不选择3D矫正。注：顶装模式下无需开启此项。

* `UNDO`：撤销上一步操作

#### 3.1 雷达监测区域设置

![LAYOUT](gif/layout_monitor.gif)

* 通过面板或底图选中某个雷达，点击面板 `Monitor` 按钮，进入该雷达的监测区域设置

* 新增区域：点击 `ADD NEW` 按钮，进入添加区域模式，通过选定多边形端点确定形状，并为区域命名，点击 `FINISH` 确认保存

* 调整区域：选中某区域，通过拖动端点，可以灵活调整区域形状，双击某个端点可以删除该端点

* 删除区域：选中某区域，点击 `DEL` 可以删除选中的区域；点击 `CLR ALL` 删除该雷达下的所有Monitor区域（审慎操作！！！）

* 点击 DONE 退出Monitor区域编辑

#### 3.2 雷达硬件区域设置

* 设置雷达硬件支持的监测/过滤区域，需要RMM专属雷达支持（即将推出）

### B. 🛡️ 区域管理（Zones）

点击面板中的 `Zones` 进入区域管理模式。

   注意：Zones 是基于融合后的坐标进行判断的，不依赖于特定雷达。此时地图上显示的是融合后的目标（默认为金色）。

![ZONE](gif/zones_select.gif)

#### 1. Detect Trigger 区域

* 编辑操作与 Monitor 区域相同。

* `Dly` (延迟)：支持设置目标进入/离开的消抖延迟（单位：秒），避免误报。

* 用途：设置后会自动创建 `binary_sensor` (存在) 和 `sensor` (人数) 实体，用于自动化。

![ZONE](images/rmm_sensors.png)


#### 2. Detect Exclude 区域

![ZONE](images/zones_exam_2.png)

* 编辑操作与 Monitor 区域相同。

* 用途：落入该区域的融合目标会被直接丢弃，不显示、不触发。适用于排除风扇、空调、绿植等固定干扰源。

#### 3. Entrance Zones (入口区域)

![ZONE](images/zones_entrance.png)

* 编辑操作与 Monitor 区域相同。

* 用途：落入该区域的融合目标立即赋予“活人认证”，无需等待`verify`延迟。 

#### 4. Stationary Hold （静止驻留区域）

![ZONE](images/zones_stationary.png)

* 编辑操作与 Monitor 区域相同。

* 可通过设置`Dly`单独定义驻留容忍时长，单位：秒，留空或设为 0 则默认使用系统全局的 `S_Hold` 时间。

* 用途：当雷达在此区域内因目标绝对静止而短暂丢失信号时，系统会在原地锁定一个“驻留锚点”，在倒计时结束前持续向智能家居汇报“有人”。    

### C. ⚙️ 参数设置（Set）

点击面板中的 `Set` 进入参数设置

![SET](images/set_1.png)

* `Interval`: 后端轮询与计算的刷新间隔（秒）。
* `Merge`: 雷达目标融合距离（单位：米）。小于该距离的不同雷达目标将被合并为一个。

* `Color`: 自定义融合目标的显示颜色
* `Tgt_H`: 目标质心高度，用于3D矫正

* `Track` (追踪开关): 开启后激活高级防重影与运动学追踪引擎；关闭则退化为简单无状态透传模式。
* `Labels` (显示序号): 开启后在地图的实心目标点上显示 `1, 2, 3...` 追踪编号。
* `Smooth` (平滑度): 目标移动轨迹的顺滑程度（1-10级）。
* `Verify` (验证延迟 & 规则): 双轨制验证引擎。
  * **勾选 (常规模式)**：允许在房间任意位置生成目标，但需经过设定的**观察期(秒)**才能转正，有效滤除随机噪点。
  * **取消勾选 (严格入口模式)**：开启绝对的一票否决！只有从“入口区域 (Entrance)”进来的目标才合法，底层静默抹杀凭空出现的飞虫或风扇干扰。
* `Hbm_TTL` (休眠保质期): 目标暂时消失后，系统保留其“记忆快照”的时间（小时）。原路返回可瞬间唤醒并继承原ID，保证追踪连贯性。推荐默认 12h。
* `S_Hold` (全局驻留): 全局静止驻留区的默认续命容忍时间（秒）。
* `J_Base` (基础跳跃容差): 容忍雷达静止时目标抖动的物理极限（单位：米）。推荐设置范围：0.8 - 1.5 米。
* `J_Speed` (极限移动速度): 设定人类在室内可能达到的最快移动速度（单位：米/秒），构成坚不可摧的“动态防瞬移结界”。推荐设置范围：2 - 3 米/秒。
* `Backup` / `Restore`: 导出或导入 JSON 配置文件，方便备份与迁移。
* `Clear Tracks`: 清空当前地图上的历史轨迹和目标编号。

![SET](gif/set_color.gif)


## ❤️ 支持项目
如果你觉得这个项目对你有帮助，请给它点个 **⭐️ Star**！

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/moe8383)
[![支持我](https://img.shields.io/badge/赞助-爱发电-af46a1?style=for-the-badge&logo=alipay&logoColor=white)](https://afdian.com/a/moe8383)

* **问题反馈 (Bugs)**：请提交 [Issue](https://github.com/Moe8383/radar_map_manager/issues)。
