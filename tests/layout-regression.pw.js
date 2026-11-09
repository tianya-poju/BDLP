async (page) => {
 const origin=new URL(page.url()).origin;
 if(!origin.startsWith('http://127.0.0.1:'))throw Error('Layout test must run only on its local fixture');
 const stable=()=>page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
 const results=[];
 for(const size of [{width:1280,height:720},{width:900,height:600},{width:760,height:520},{width:540,height:420}]){
  await page.setViewportSize(size);
  for(const n of [28,160]){
   await page.goto(`${origin}/layout?view=preview&n=${n}`);await page.waitForFunction(()=>window.layoutRecords?.length>0);await stable();
   const before=await page.evaluate(()=>({height:document.querySelector('.route-preview-map').getBoundingClientRect().height,open:document.querySelector('details').open,footer:document.querySelector('.modal-foot').getBoundingClientRect().bottom,viewport:innerHeight,disabled:document.querySelector('.modal-foot .btn-primary').disabled}));
   if(before.height<279||before.open||before.footer>before.viewport+1||!before.disabled)throw Error('Collapsed preview failed '+JSON.stringify({size,n,before}));
   await page.getByText('查看详情',{exact:true}).click();
   const after=await page.evaluate(()=>({height:document.querySelector('.route-preview-map').getBoundingClientRect().height,detail:document.querySelector('.route-preview-detail-scroll').getBoundingClientRect().height,footer:document.querySelector('.modal-foot').getBoundingClientRect().bottom,viewport:innerHeight}));
   if(Math.abs(after.height-before.height)>1||after.detail>201||after.footer>after.viewport+1)throw Error('Expanded preview failed '+JSON.stringify({size,n,after}));
   results.push({view:'preview',...size,n,mapHeight:before.height,detailHeight:after.detail});
  }
 }
 await page.setViewportSize({width:1280,height:720});
 for(const view of ['editor','record','console']){
  await page.goto(`${origin}/layout?view=${view}`);await page.waitForFunction(()=>window.layoutRecords?.length>0);await stable();
  const result=await page.evaluate(()=>{const map=document.querySelector('.map'),r=map.getBoundingClientRect();return{height:r.height,width:r.width,position:getComputedStyle(map).position,panelWidth:document.querySelector('.fullpage-panel')?.getBoundingClientRect().width,initialized:window.layoutRecords[0]};});
  if(result.height<=0||result.initialized.height<=0)throw Error('Zero-size map '+view);
  if(view!=='console'&&result.position!=='absolute')throw Error('Fill positioning lost '+view);
  if(view==='editor'&&Math.abs(result.width-result.panelWidth)>2)throw Error('Editor is not 50/50');
  await page.setViewportSize({width:1000,height:600});
  const resized=await page.locator('.map').evaluate(el=>el.getBoundingClientRect().height);if(resized<=0)throw Error('Map collapsed on resize');
  results.push({view,...result,resizedHeight:resized});await page.setViewportSize({width:1280,height:720});
 }
 await page.setViewportSize({width:900,height:600});await page.goto(`${origin}/layout?view=sidebar`);await page.waitForFunction(()=>window.layoutReady);await page.waitForTimeout(5600);
 if(await page.evaluate(()=>window.layoutRecords.length)!==0)throw Error('Hidden sidebar initialized prematurely');
 await page.setViewportSize({width:1600,height:900});await page.waitForFunction(()=>window.layoutRecords.length===1);await stable();
 for(let i=0;i<3;i++){await page.setViewportSize({width:900,height:600});await page.waitForTimeout(100);await page.setViewportSize({width:1600,height:900});await page.waitForTimeout(100);}
 await page.evaluate(()=>window.rebuildMap());await page.waitForFunction(()=>window.layoutRecords.length===2);
 const recovery=await page.evaluate(()=>({maps:layoutRecords.length,height:document.querySelector('.map').getBoundingClientRect().height,error:document.querySelector('.map-status')?.textContent||''}));
 if(recovery.height<=0||recovery.error)throw Error('Sidebar recovery failed '+JSON.stringify(recovery));results.push({view:'hidden-sidebar-recovery',...recovery});
 await page.goto(`${origin}/layout?view=preview&n=28`);await page.waitForFunction(()=>window.layoutRecords?.length>0);await stable();
 await page.screenshot({path:'output/playwright/preview-120-collapsed.png'});
 return results;
}
