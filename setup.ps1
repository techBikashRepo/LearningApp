# =============================================================================
# setup.ps1 - Learning App Content Setup Script
# Run once to copy curriculum markdown files and generate curriculum.json
# =============================================================================

$CurriculumRoot = "C:\Bikash\Workspace\curriculum"
$OutputRoot     = "$PSScriptRoot\content"
$ManifestFile   = "$PSScriptRoot\curriculum.json"

$SubjectData = @(
    @{ num = "01"; id = "01-networking";                 title = "Networking";                     icon = "network"      }
    @{ num = "02"; id = "02-backend-api-design";         title = "Backend and API Design";         icon = "backend"      }
    @{ num = "03"; id = "03-authentication-security";    title = "Authentication and Security";    icon = "security"     }
    @{ num = "04"; id = "04-databases-data-modeling";    title = "Databases and Data Modeling";    icon = "database"     }
    @{ num = "05"; id = "05-system-design-architecture"; title = "System Design and Architecture"; icon = "architecture" }
)

$PartSubtitles = @{
    "01" = "Foundations"
    "02" = "Real World and Interview Prep"
    "03" = "AWS Focus and Quick Revision"
}

function Slugify($str) {
    $slug = $str.ToLower()
    $slug = [regex]::Replace($slug, '[^a-z0-9]', '-')
    $slug = [regex]::Replace($slug, '-{2,}', '-')
    return $slug.Trim('-')
}

Write-Host "Learning App Content Setup" -ForegroundColor Cyan
Write-Host "Source: $CurriculumRoot"
Write-Host "Dest:   $OutputRoot"
Write-Host ""

if (-not (Test-Path $OutputRoot)) { New-Item -ItemType Directory -Path $OutputRoot | Out-Null }

$subjects = [System.Collections.Generic.List[hashtable]]::new()
$subjectFolders = Get-ChildItem -Path $CurriculumRoot -Directory | Sort-Object Name

foreach ($subjectFolder in $subjectFolders) {
    $subjectName = $subjectFolder.Name
    $subjectNum  = ($subjectName -split ' - ')[0].Trim()
    $meta = $SubjectData | Where-Object { $_.num -eq $subjectNum }
    if (-not $meta) { continue }

    $subjectId = $meta.id
    Write-Host "Subject: $($meta.title)" -ForegroundColor Green

    $subjectOutputDir = Join-Path $OutputRoot $subjectId
    if (-not (Test-Path $subjectOutputDir)) { New-Item -ItemType Directory -Path $subjectOutputDir | Out-Null }

    $chapters = [System.Collections.Generic.List[hashtable]]::new()
    $chapterFolders = Get-ChildItem -Path $subjectFolder.FullName -Directory | Sort-Object Name

    foreach ($chapterFolder in $chapterFolders) {
        $cname  = $chapterFolder.Name
        $cparts = $cname -split ' - ', 2
        if ($cparts.Count -lt 2) { continue }
        $chapterNum   = $cparts[0].Trim()
        $chapterTitle = $cparts[1].Trim()
        $chapterId    = "$chapterNum-$(Slugify $chapterTitle)"
        Write-Host "  $chapterNum - $chapterTitle" -ForegroundColor White

        $chapterOutputDir = Join-Path $subjectOutputDir $chapterId
        if (-not (Test-Path $chapterOutputDir)) { New-Item -ItemType Directory -Path $chapterOutputDir | Out-Null }

        $partsArr = [System.Collections.Generic.List[hashtable]]::new()
        $partFiles = Get-ChildItem -Path $chapterFolder.FullName -Filter "*.md" | Sort-Object Name

        foreach ($partFile in $partFiles) {
            $pNumStr  = ($partFile.Name -split '-')[0].Trim()
            $subtitle = if ($PartSubtitles.ContainsKey($pNumStr)) { $PartSubtitles[$pNumStr] } else { "Part $pNumStr" }
            $outFile  = "$pNumStr-$(Slugify $chapterTitle).md"
            $outPath  = Join-Path $chapterOutputDir $outFile
            Copy-Item -Path $partFile.FullName -Destination $outPath -Force
            $partsArr.Add(@{ num = [int]$pNumStr; subtitle = $subtitle; file = "content/$subjectId/$chapterId/$outFile" })
            Write-Host "    Part $pNumStr -> $outFile" -ForegroundColor DarkCyan
        }

        $chapters.Add(@{ id = $chapterId; title = $chapterTitle; number = [int]$chapterNum; parts = $partsArr.ToArray() })
    }

    $subjects.Add(@{ id = $subjectId; title = $meta.title; icon = $meta.icon; number = [int]$subjectNum; chapters = $chapters.ToArray() })
}

$manifest = @{ title = "Bikash Learning Portal"; subjects = $subjects.ToArray() }
Write-Host "`nWriting curriculum.json..." -ForegroundColor Yellow
$json = $manifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($ManifestFile, $json, [System.Text.Encoding]::UTF8)
Write-Host "Done! Open index.html with VS Code Live Server." -ForegroundColor Green
