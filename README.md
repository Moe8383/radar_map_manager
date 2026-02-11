# Radar Map Manager (RMM)

![Logo](logo.png)

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![version](https://img.shields.io/github/v/release/Moe8383/radar_map_manager_repo)](https://github.com/Moe8383/radar_map_manager_repo/releases)

> 🇨🇳 **Chinese User?** [点击这里查看中文说明 (Click here for Chinese)](README_zh.md)

**Radar Map Manager (RMM)** is an advanced millimeter-wave radar visualization and sensor fusion integration designed for Home Assistant.

It is not just a map card, but a powerful **spatial perception engine**. RMM maps data from multiple scattered radars (e.g., LD2410, LD2450, LD2460) onto your floor plan, enabling tracking, trajectory visualization, and precise coordinate-based automation.

> 🚀 **V1.0.0 Released!** Now supports **Ceiling Mount**, **Exclude Zones**, and a smoother editor experience.

---

## ✨ Key Features

### 1. 🎯 WYSIWYG Visual Editor
Say goodbye to complex YAML coordinate calculations! RMM provides an interactive frontend editor:
* **Drag & Drop**: Drag radar icons directly on your floor plan.
* **Transform**: Support for rotation, scaling, and mirroring.
* **Dual Modes**: Perfectly supports **Side Mount** and **Ceiling Mount** (auto-switches to circular tracking view).

### 2. 🌐 Multi-Radar Sensor Fusion
The backend engine fuses target points from multiple radars into a single coordinate system:
* **Auto-Clustering**: Merges data when multiple radars detect the same person to prevent "ghost targets."
* **Blind Spot Coverage**: Overlap multiple radars to eliminate dead zones in rooms.

### 3. 🛡️ Powerful Zone Management
* **Monitor Zones**: Draw a zone; automation triggers only when a target enters it.
* **Exclude Zones**: **The solution for false alarms!** Draw zones around fans, curtains, or plants. The engine automatically filters out all interference signals within these areas.
* **Automation Entities**: Each zone generates a corresponding `binary_sensor` for precise automation (e.g., "Person on Sofa", "Person in Kitchen").

### 4. 📐 3D Spatial Correction
For side-mounted radars, RMM features a built-in 3D geometric correction algorithm. It converts Slant Range to Ground Distance based on installation height and target height, significantly improving positioning accuracy.

---

## 🛠️ Supported Hardware

RMM is designed to be compatible with any mmWave radar integrated into Home Assistant that provides X/Y coordinates or distance data.

* **Fully Supported**:
    * **Hi-Link LD2450 / LD2460** (Recommended, supports tracking coordinates)
    * **Hi-Link LD2410** (Supports single target & 1D distance mode)
* **Protocols**:
    * ESPHome (Recommended)
    * MQTT
    * Zigbee (Must report coordinates)

---

## 📦 Installation

### Option 1: HACS (Recommended)
1.  Open HACS -> **Integrations**.
2.  Click the menu (three dots) -> **Custom repositories**.
3.  Add `https://github.com/Moe8383/radar_map_manager_repo`, select category **Integration**.
4.  Search for "Radar Map Manager" and install.
5.  Restart Home Assistant.

### Option 2: Manual Installation
1.  Download the `custom_components/radar_map_manager` folder from this repository.
2.  Copy it to your Home Assistant's `custom_components/` directory.
3.  Restart Home Assistant.

---

## ⚙️ Configuration

### Step 1: Add Integration
1.  Go to **Settings** -> **Devices & Services** -> **Add Integration**.
2.  Search for **Radar Map Manager** and add it.

### Step 2: Add Card
1.  Edit your Dashboard -> **Add Card**.
2.  Search for **Radar Map Manager**.
3.  Or use YAML configuration:

```yaml
type: custom:radar-map-card
map_group: default
bg_image: /local/floorplan.png  # Path to your floor plan
target_radius: 8                # Size of the target dot
target_colors:                  # Custom colors for targets
  - "#00FF00"
  - "#00FFFF"
  - "#FF00FF"
```

### Step 3: Start Editing
Click the ⚙️ (Gear) icon on the card to enter Edit Mode.

Add Radar: Click Layout -> + and select your radar entity.

Adjust: Drag the radar, adjust Rotation and Scale to match your floor plan.

Draw Zones: Switch to Zones mode to draw polygons for automation triggers.

🔜 Roadmap
We are committed to creating the ultimate radar experience. Future plans include:

Auto-Calibration: "One-click map alignment" using IMU (requires upcoming RMM Pro hardware).

High-Frequency Mode: Unlock 20Hz+ silky-smooth tracking with custom firmware.

Edge Computing: Offload zone processing to hardware for zero-latency automation.

❤️ Support
If you find this project helpful, please give it a ⭐️ Star!

Bugs: Please open an Issue.

Discussions: Share your setup in the Discussions tab.

License: MIT


### ☕ 支持我的项目

如果您觉得这个项目对您有帮助，可以通过以下方式支持我，这将用于项目的后续开发和硬件耗材购买：

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/moe8383)
[![支持我](https://img.shields.io/badge/赞助-爱发电-af46a1?style=for-the-badge&logo=alipay&logoColor=white)](https://afdian.com/a/moe8383)
