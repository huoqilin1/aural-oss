$ErrorActionPreference='Stop'
Set-Location 'D:/GGGG/kiro/aural-entry-fix-20260913'
for($round=1;$round -le 200;$round++) {
 if(Test-Path output/local-ten-retake-driver.stop){break}
 & npx --no-install --package '@playwright/cli' playwright-cli -s=hr-local-ten run-code --filename=output/local-ten-retake-step.js *> "output/local-ten-retake-round-$round.log"
 $lines=Get-Content "output/local-ten-retake-round-$round.log"
 if($lines[0] -ne '### Result'){Write-Output "driver_error round=$round";break}
 $s=$lines[1]|ConvertFrom-Json
 $progress=@{round=$round;done=@($s|Where-Object done).Count;terminal=@($s|Where-Object terminal).Count;errors=@($s|Where-Object error).Count;questions=@($s|ForEach-Object{"$($_.index):$($_.q)"});asrEnds=($s|Measure-Object asrEnds -Sum).Sum;at=(Get-Date).ToString('o')}
 $progress|ConvertTo-Json -Compress|Tee-Object -FilePath output/local-ten-retake-progress.json
 if($progress.done -eq 10){break}
 if($progress.terminal -eq 10 -and $progress.done -eq 0){Write-Output 'all_terminal_without_completion';break}
 Start-Sleep -Seconds 5
}
