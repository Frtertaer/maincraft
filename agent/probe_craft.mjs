import mineflayer from 'mineflayer'
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'ProbeCraft5', version: '1.21.1' })
bot.once('spawn', async () => {
  await new Promise(r => setTimeout(r, 1500))
  const mcData = (await import('minecraft-data')).default(bot.version)
  const stick = mcData.itemsByName.stick
  for (let i=0;i<40;i++) {
    await new Promise(r=>setTimeout(r,500))
    if (bot.inventory.items().some(i=>i.name==='oak_planks')) break
  }
  const win = bot.inventory
  const rs = bot.recipesFor(stick.id, null, 1, null)
  console.log('recipesFor:', rs.length)
  try { await bot.craft(rs[0], 1, null); console.log('craft resolved') } catch(e){ console.log('CRAFT FAIL:', e.message) }
  for (const delay of [100, 500, 1500]) {
    await new Promise(r=>setTimeout(r,delay))
    const have = win.items().filter(i=>i.name==='stick').map(i=>i.count+'@'+i.slot).join(',')
    const grids = [1,2,3,4].map(s=>win.slots[s]).filter(Boolean).map(i=>i.name+'x'+i.count+'@grid').join(',')
    console.log(`+${delay}ms: sticks=[${have}] grids=[${grids}] count848=${win.count(848)}`)
  }
  // server-side truth requested via rcon? print all slots
  for (let s=0;s<win.slots.length;s++){const it=win.slots[s]; if(it) console.log('slot',s,it.name,'x',it.count)}
  process.exit(0)
})
bot.on('error', e => { console.log('ERR', e.message); process.exit(1) })
