#!/bin/bash
# Фаза 1: скачивание кандидатов для замера (Linux/Mac). После: node bench-models.mjs
set -e
echo "Качаю RTMPose-m (позы, Apache-2.0)..."
curl -L -o rtmpose-m.zip "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip"
unzip -o rtmpose-m.zip -d rtmpose-m
find rtmpose-m -name "*.onnx" | head -1 | xargs -I{} cp {} rtmpose_m.onnx
echo "Готово. Теперь: node bench-models.mjs"
