# Фаза 1: скачивание кандидатов для замера НА ЭТОЙ МАШИНЕ (Windows PowerShell)
# Модели лежат на CDN OpenMMLab — из офиса/дома качаются свободно.
# После скачивания:  node bench-models.mjs
$ErrorActionPreference = "Stop"
Write-Host "Качаю RTMPose-m (позы, Apache-2.0)..."
Invoke-WebRequest -Uri "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip" -OutFile "rtmpose-m.zip"
Expand-Archive -Path "rtmpose-m.zip" -DestinationPath "rtmpose-m" -Force
Get-ChildItem -Recurse rtmpose-m -Filter *.onnx | Select-Object -First 1 | Copy-Item -Destination "rtmpose_m.onnx"
Write-Host "Качаю RTMDet-nano (детекция людей для топ-дауна)..."
Invoke-WebRequest -Uri "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmdet-nano_8xb32-100e_coco-obj365-person-05d8511e_20230405.zip" -OutFile "rtmdet-nano.zip"
Expand-Archive -Path "rtmdet-nano.zip" -DestinationPath "rtmdet-nano" -Force
Write-Host "Готово. Теперь: node bench-models.mjs"
