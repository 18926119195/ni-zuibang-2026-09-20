# =============================================================================
# 对比新旧 final-noun-index.json 的差异
#
# 用法：
#   cd C:\Users\Administrator\Desktop\ni-zuibang-master
#   .\compare-final-noun-index.ps1
#
# 默认对比 final-noun-index.json（老）和 final-noun-index.json.new（新）
# =============================================================================

$ErrorActionPreference = 'Stop'

$OldPath = Join-Path $PSScriptRoot 'final-noun-index.json'
$NewPath = Join-Path $PSScriptRoot 'final-noun-index.json.new'

if (-not (Test-Path $OldPath)) { Write-Host "[X] 找不到 $OldPath" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $NewPath)) { Write-Host "[X] 找不到 $NewPath" -ForegroundColor Red; exit 1 }

Write-Host "`n=== Meta 对比 ===" -ForegroundColor Cyan
$oldMeta = (Get-Content $OldPath -Raw | ConvertFrom-Json).meta
$newMeta = (Get-Content $NewPath -Raw | ConvertFrom-Json).meta

$fields = @('totalNouns','s0Count','s1Count','totalOffsets','fullTextLength')
foreach ($f in $fields) {
    $ov = if ($oldMeta.PSObject.Properties[$f]) { $oldMeta.$f } else { '(无)' }
    $nv = if ($newMeta.PSObject.Properties[$f]) { $newMeta.$f } else { '(无)' }
    $diff = ''
    if ($ov -ne '(无)' -and $nv -ne '(无)') {
        if ([double]$nv -gt [double]$ov) { $diff = " (+$([double]$nv - [double]$ov))"; $color = 'Green' }
        elseif ([double]$nv -lt [double]$ov) { $diff = " ($([double]$nv - [double]$ov))"; $color = 'Yellow' }
        else { $color = 'Gray' }
    } else { $color = 'Gray' }
    Write-Host ("  {0,-20}  老: {1,8}  新: {2,8}{3}" -f $f, $ov, $nv, $diff) -ForegroundColor $color
}

Write-Host "`n=== 构建 id 集合 ===" -ForegroundColor Cyan
$old = Get-Content $OldPath -Raw | ConvertFrom-Json
$new = Get-Content $NewPath -Raw | ConvertFrom-Json
$oldIds = @{}; foreach ($n in $old.nouns) { $oldIds[$n.id] = $n }
$newIds = @{}; foreach ($n in $new.nouns) { $newIds[$n.id] = $n }

$added = @($newIds.Keys | Where-Object { -not $oldIds.ContainsKey($_) } | Sort-Object)
$removed = @($oldIds.Keys | Where-Object { -not $newIds.ContainsKey($_) } | Sort-Object)

Write-Host "`n=== id 差异 ===" -ForegroundColor Cyan
Write-Host "  新增: $($added.Count) 个" -ForegroundColor Green
Write-Host "  消失: $($removed.Count) 个" -ForegroundColor Yellow
Write-Host "  共有: $($newIds.Count - $added.Count) 个" -ForegroundColor Gray

if ($added.Count -gt 0 -and $added.Count -le 50) {
    Write-Host "`n  新增 id（前 50 个）:" -ForegroundColor Green
    $added | Select-Object -First 50 | ForEach-Object { Write-Host "    $_" }
}
if ($removed.Count -gt 0 -and $removed.Count -le 50) {
    Write-Host "`n  消失 id（前 50 个）:" -ForegroundColor Yellow
    $removed | Select-Object -First 50 | ForEach-Object { Write-Host "    $_" }
}

# 共有 id 的 surface / offsets 变化
Write-Host "`n=== 共有 id 的细节差异 ===" -ForegroundColor Cyan
$surfaceChanged = 0
$offsetsChanged = 0
$onlyInOldOffsets = @()
$onlyInNewOffsets = @()
$commonChanged = 0

foreach ($id in $newIds.Keys) {
    if (-not $oldIds.ContainsKey($id)) { continue }
    $o = $oldIds[$id]; $n = $newIds[$id]
    if ($o.surface -ne $n.surface) { $surfaceChanged++ }
    $oOff = ($o.offsets | ForEach-Object { "$($_.chunkKey)|$($_.start)|$($_.end)" }) | Sort-Object
    $nOff = ($n.offsets | ForEach-Object { "$($_.chunkKey)|$($_.start)|$($_.end)" }) | Sort-Object
    if (($oOff -join ',') -ne ($nOff -join ',')) {
        $offsetsChanged++
        if ($oOff.Count -ne $nOff.Count) { $commonChanged++ }
    }
}

Write-Host "  surface 变化的 id: $surfaceChanged 个"
Write-Host "  offsets 位置变化的 id: $offsetsChanged 个"

# offsets 数量变化的 id（同一个词出现次数变了）
Write-Host "`n=== offsets 数量变化最大的前 20 个 id ===" -ForegroundColor Cyan
$changes = foreach ($id in $newIds.Keys) {
    if (-not $oldIds.ContainsKey($id)) { continue }
    $o = $oldIds[$id]; $n = $newIds[$id]
    $oc = if ($o.offsets) { $o.offsets.Count } else { 0 }
    $nc = if ($n.offsets) { $n.offsets.Count } else { 0 }
    if ($oc -ne $nc) {
        [PSCustomObject]@{
            id = $id
            oldCount = $oc
            newCount = $nc
            diff = $nc - $oc
        }
    }
}
$changes | Sort-Object diff -Descending | Select-Object -First 20 | Format-Table -AutoSize

Write-Host "`n完成。`n" -ForegroundColor Cyan
