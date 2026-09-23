$ErrorActionPreference='Stop'
Set-Location 'D:/GGGG/kiro/aural-entry-fix-20260913'
for($round=1;$round -le 40;$round++) {
  if(Test-Path output/local-ten-driver.stop){break}
  & npx --no-install --package '@playwright/cli' playwright-cli -s=hr-local-ten run-code --filename=output/local-ten-next-ready.js *> "output/local-ten-next-round-$round.log"
  & npx --no-install --package '@playwright/cli' playwright-cli -s=hr-local-ten run-code --filename=output/local-ten-speak-ready.js *> "output/local-ten-speak-round-$round.log"
  & npx --no-install --package '@playwright/cli' playwright-cli -s=hr-local-ten run-code --filename=output/local-ten-observe.js *> "output/local-ten-observe-round-$round.log"
  $lines=Get-Content "output/local-ten-observe-round-$round.log"
  if($lines[0] -ne '### Result'){Write-Output "driver_observe_error round=$round"; break}
  $snapshot=$lines[1] | ConvertFrom-Json
  $progress=@{round=$round;done=@($snapshot|Where-Object done).Count;questions=@($snapshot|ForEach-Object {"$($_.index):$($_.question)"});at=(Get-Date).ToString('o')}
  $progress|ConvertTo-Json -Compress|Tee-Object -FilePath output/local-ten-driver-progress.json
  if($progress.done -eq 10){break}
  Start-Sleep -Seconds 15
}
