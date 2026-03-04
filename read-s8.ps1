
# Read actual Section 8 from a Part 2 file fully
$enc = [System.Text.Encoding]::UTF8
$f = "C:\Bikash\Workspace\LearningApp\content\06-scalability-performance\01-vertical-vs-horizontal-scaling\02-vertical-vs-horizontal-scaling.md"
$content = [System.IO.File]::ReadAllText($f, $enc)
$m = [regex]::Match($content, '(?s)## SECTION 8[^\n]+\n(.+?)$')
if ($m.Success) { Write-Output $m.Groups[1].Value }
