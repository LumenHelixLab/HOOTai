# Upstream moved skills from plugins/compound-engineering/skills/ to root skills/ (v3.x restructure)
$baseUrl = "https://raw.githubusercontent.com/EveryInc/compound-engineering-plugin/main/skills"
$cacheDir = Join-Path $PSScriptRoot ".." "skills" "compound-engineering" "cache"
$skills = @(
  "ce-strategy",
  "ce-ideate",
  "ce-brainstorm",
  "ce-plan",
  "ce-work",
  "ce-code-review",
  "ce-compound",
  "ce-debug",
  "ce-product-pulse"
)

foreach ($skill in $skills) {
  $outDir = Join-Path $cacheDir $skill
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $url = "$baseUrl/$skill/SKILL.md"
  try {
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $outDir "SKILL.md") -TimeoutSec 15
    Write-Host "Synced $skill"
  } catch {
    Write-Host "Failed to sync ${skill}: $_"
    $global:LASTEXITCODE = 1
  }
}
Write-Host "Done."
