import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Downloads are explicit and precede the network-isolated acceptance run.
const directory = resolve('.local-ai-validation')
await mkdir(directory, { recursive: true })
for (const model of ['qwen3:4b', 'qwen3:8b']) {
  console.log(JSON.stringify({ model, event: 'pull-start', at: new Date().toISOString() }))
  const response = await fetch('http://127.0.0.1:11434/api/pull', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(7_200_000),
  })
  if (!response.ok || !response.body) throw new Error(`pull_http_${response.status}`)
  let buffered = '', last = '', success = false, lastProgress = 0
  const events = []
  for await (const bytes of response.body) {
    buffered += new TextDecoder().decode(bytes)
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (event.error) throw new Error(event.error)
      const percent = event.total ? Math.floor(100 * event.completed / event.total) : undefined
      if (event.status !== last || Date.now() - lastProgress > 15_000) {
        const receipt = { at: new Date().toISOString(), ...event, percent }
        events.push(receipt); console.log(JSON.stringify({ model, ...receipt }))
        lastProgress = Date.now(); last = event.status
      }
      if (event.status === 'success') success = true
    }
  }
  if (!success) throw new Error('pull_incomplete')
  await writeFile(resolve(directory, `download-${model.replace(':', '-')}.json`), JSON.stringify(events, null, 2))
}
await writeFile(resolve(directory, 'model-tags.json'), JSON.stringify(await (await fetch('http://127.0.0.1:11434/api/tags')).json(), null, 2))
