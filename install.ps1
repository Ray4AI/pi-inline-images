# 安装 pi-inline-images 到 pi 扩展目录（Windows）
$src = Join-Path $PSScriptRoot "pi-inline-images.ts"
$destDir = if ($env:PI_AGENT_DIR) { Join-Path $env:PI_AGENT_DIR "extensions" } else { Join-Path $env:USERPROFILE ".pi\agent\extensions" }

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Copy-Item $src (Join-Path $destDir "pi-inline-images.ts") -Force
Write-Host "已安装: $destDir\pi-inline-images.ts"
Write-Host "重启 pi 或执行 /reload 后生效。"
