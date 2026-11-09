"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// src/devices.js
var require_devices = __commonJS({
  "src/devices.js"(exports2, module2) {
    "use strict";
    var DEVICE_PRESETS = [
      { name: "Xiaomi 17", model: "25113PN0EC", osVersion: "16", released: "2025-09" },
      { name: "REDMI K90", model: "2510DRK44C", osVersion: "16", released: "2025-10" },
      { name: "REDMI K90 Pro", model: "25102RKBEC", osVersion: "16", released: "2025-10" },
      { name: "Galaxy S26", model: "SM-S942B", osVersion: "16", released: "2026-02" }
    ];
    module2.exports = { DEVICE_PRESETS };
  }
});


export const {DEVICE_PRESETS}=require_devices();
