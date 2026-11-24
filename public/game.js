'use strict';

const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
const $ = (id) => document.getElementById(id);
const joinScreen = $('joinScreen');
const gameScreen = $('gameScreen');
const joinForm = $('joinForm');
const joinError = $('joinError');
const floorChoice = $('floorChoice');
const building = $('building');
const onlineCount = $('onlineCount');
const toast = $('toast');
const serverStatus = $('serverStatus');
const TOKEN_KEY = 'hotel96-player-token-v2';
const NAME_KEY = 'hotel96-player-name-v2';
const FLOOR_KEY = 'hotel96-player-floor-v2';
const MANUAL_LOGOUT_KEY = 'hotel96-manual-logout-v5';
let chatFloor = null;

let selfId = null;
let selfPlayer = null;
let latestState = null;
let toastTimer = null;
let previousFloor = null;
let resumeInProgress = false;
let resumeAttemptedForSocket = false;
let activeHouseRoom = null;
let pendingHouseInviteId = null;
let miniGameTimerInterval = null;
let pendingNameOffers = [];
let voiceStream = null;
const voicePeers = new Map();
let parkAnimationFrame = null;
let parkPosition = { x: 10, z: 10 };
let lastParkSentAt = 0;

const faNumber = (number) => new Intl.NumberFormat('fa-IR').format(number);
const floorTitle = (floor) => floor < 0
  ? `منفی ${faNumber(Math.abs(floor))}`
  : floor === 0 ? 'صفر' : faNumber(floor);

const MINI_GAMES = [
  { id: 'football', icon: '⚽', title: 'فوتبال', description: 'شوت بزن و گل جمع کن.' },
  { id: 'pingpong', icon: '🏓', title: 'پینگ‌پنگ', description: 'توپ را برگردان و امتیاز بگیر.' },
  { id: 'race', icon: '🏁', title: 'مسابقه ماشین', description: 'گاز بده و از رقیبت جلو بزن.' },
  { id: 'puzzle', icon: '🧩', title: 'مسابقه معما', description: 'به سؤال‌ها سریع و درست جواب بده.' },
  { id: 'target', icon: '🎯', title: 'هدف‌گیری با توپ', description: 'هدف‌های رنگی را بزن.' },
  { id: 'basketball', icon: '🏀', title: 'بسکتبال', description: 'پرتاب کن و دو امتیاز بگیر.' },
  { id: 'record', icon: '🕹️', title: 'رکوردزنی', description: 'در زمان محدود رکورد بزن.' }
];

for (let floor = 1; floor <= 24; floor += 1) {
  const option = document.createElement('option');
  option.value = String(floor);
  option.textContent = `طبقه ${faNumber(floor)}`;
  if (floor === 12) option.selected = true;
  floorChoice.appendChild(option);
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3500);
}

function showJoinError(message) {
  joinError.textContent = message;
  joinError.hidden = false;
}

function setServerStatus(text, connected) {
  serverStatus.textContent = text;
  serverStatus.classList.toggle('connected', Boolean(connected));
  serverStatus.classList.toggle('disconnected', !connected);
}

function updatePlayerPanel() {
  if (!selfPlayer) return;
  $('myName').textContent = selfPlayer.name;
  $('myAvatar').textContent = selfPlayer.equipped ? (selfPlayer.equipped==='uniform'?'🎓':selfPlayer.equipped==='coat'?'🧥':selfPlayer.equipped==='cap'?'🧢':'🐾') : selfPlayer.name.slice(0, 1);
  $('myAvatar').style.background = selfPlayer.color;
  $('myFloor').textContent = `${floorTitle(selfPlayer.floor)} (حد بالا: ${floorTitle(selfPlayer.maxFloor)})`;
  const keyStatus = $('keyStatus');
  keyStatus.classList.toggle('has-key', selfPlayer.hasKey);
  keyStatus.replaceChildren();
  const icon = document.createElement('span');
  icon.textContent = selfPlayer.hasKey ? '🗝️' : '🔒';
  const label = document.createElement('small');
  label.textContent = selfPlayer.hasKey ? 'کلید داری' : 'کلید نداری';
  keyStatus.append(icon, label);
  const health=Math.max(0,selfPlayer.health??100), hunger=Math.max(0,selfPlayer.hunger??100);
  $('healthValue').textContent=faNumber(health); $('hungerValue').textContent=faNumber(hunger); $('coinValue').textContent=faNumber(selfPlayer.coins??100);
  $('healthBar').style.width=`${health}%`; $('hungerBar').style.width=`${hunger}%`;
  const roleText = selfPlayer.role === 'admin' ? '👑 ادمین' : selfPlayer.role === 'guard' ? '🛡️ گارد' : 'ساکن';
  $('myRole').textContent = roleText;
  $('myRole').classList.toggle('admin-role', selfPlayer.role === 'admin');
  $('myRole').classList.toggle('guard-role', selfPlayer.role === 'guard');
  $('phoneButton').disabled = !selfPlayer.hasPhone;
  $('attackButton').textContent = selfPlayer.equippedWeapon ? '🗡️ حمله با شمشیر' : '👊 حمله';
  $('phoneButton').title = selfPlayer.hasPhone ? 'باز کردن گوشی' : 'برای استفاده، گوشی را از فروشگاه بخر و از اینونتوری فعال کن.';
  $('guardButton').hidden = selfPlayer.role !== 'resident' || selfPlayer.floor !== (selfPlayer.homeFloorLimit || selfPlayer.maxFloor);
  $('escapeButton').hidden = selfPlayer.floor !== 1 || ['guard','admin'].includes(selfPlayer.role);
  $('equippedLabel').textContent = `لباس: ${selfPlayer.equipped ? (selfPlayer.equipped==='uniform'?'لباس مدرسه':selfPlayer.equipped==='coat'?'کت':selfPlayer.equipped==='cap'?'کلاه':'لباس ویژه') : 'عادی'} · ${selfPlayer.equippedWeapon ? '🗡️ شمشیر مجهز' : 'مشت خالی'}`;
  $('adminPanel').hidden = selfPlayer.role !== 'admin';
  $('secureAccountButton').hidden = Boolean(selfPlayer.hasPassword);
  updateAttackTargets();
  updateAdminTargets();
  const floorOpen = latestState?.floor24Unlocked !== false;
  if ($('adminFloor24Button')) { $('adminFloor24Button').textContent = floorOpen ? '🔓 قفل ۲۴ طبقه: باز' : '🔒 قفل ۲۴ طبقه: بسته'; $('adminFloor24Button').classList.toggle('locked', !floorOpen); }
  if ($('adminFloorStatus')) $('adminFloorStatus').textContent = floorOpen ? 'طبقات تا ۲۴ برای همه باز است.' : 'طبقات بالاتر از حد شخصی بازیکنان قفل است.';
}

function updateAttackTargets(){
  const select=$('attackTarget'); if(!latestState||!selfPlayer)return;
  const old=select.value; select.replaceChildren();
  const targets=latestState.players.filter(p=>p.id!==selfId&&p.online&&p.floor===selfPlayer.floor);
  const empty=document.createElement('option'); empty.value=''; empty.textContent=targets.length?'انتخاب بازیکن':'هم‌طبقه‌ای برای حمله نیست'; select.append(empty);
  targets.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;select.append(o)});
  if(targets.some(p=>p.id===old))select.value=old;
  $('attackButton').disabled=!targets.length;
}

function openShop(shop){
  if(!selfPlayer||!latestState?.shops?.[selfPlayer.floor])return;
  if(shop?.id==='park'){openPark();return;}
  $('shopModal').hidden=false;
  $('shopTitle').textContent=`${shop.icon} ${shop.name}`;
  $('shopLoading').hidden=false;
  $('shopLoading').textContent='در حال ورود به مکان…';
  $('shopItems').replaceChildren();
  $('shopJobActions').replaceChildren();
  window.setTimeout(()=>{
    if($('shopModal').hidden)return;
    $('shopLoading').hidden=true;
    renderShopModal();
  },450);
}
function renderBankPanel(){
  const host=$('shopItems');
  const wallet=selfPlayer.cryptoWallet||{BTC:0,ETH:0,DOGE:0};
  const note=document.createElement('div');note.className='bank-market-note';
  note.textContent='🪙 بازار شبیه‌سازی‌شده داخل بازی است؛ قیمت‌ها هر دقیقه کمی تغییر می‌کنند و هیچ پول یا ارز دیجیتال واقعی در کار نیست.';
  host.append(note);
  const balance=document.createElement('p');balance.className='shop-worker-status';
  balance.textContent=`کیف پول تو: ₿ ${faNumber(wallet.BTC||0)} • ◆ ${faNumber(wallet.ETH||0)} • Ð ${faNumber(wallet.DOGE||0)} | موجودی: ${faNumber(selfPlayer.coins||0)} سکه`;
  host.append(balance);
  const market=latestState.bankMarket||{};
  for(const id of ['BTC','ETH','DOGE']){
    const asset=market[id];if(!asset)continue;
    const row=document.createElement('div');row.className='bank-trade-row';
    const title=document.createElement('strong');title.textContent=`${asset.icon||''} ${asset.name} · ${faNumber(asset.price)} سکه`;
    const qty=document.createElement('input');qty.type='number';qty.min='1';qty.max='100';qty.value='1';qty.setAttribute('aria-label','تعداد واحد');
    const buy=document.createElement('button');buy.textContent='خرید';
    const sell=document.createElement('button');sell.textContent='فروش';sell.className='sell';
    const trade=(side)=>{const quantity=Math.floor(Number(qty.value));socket.emit('bankTrade',{asset:id,side,quantity},r=>showToast(r?.message||'معامله انجام نشد.',!r?.ok));};
    buy.addEventListener('click',()=>trade('buy'));sell.addEventListener('click',()=>trade('sell'));
    row.append(title,qty,buy,sell);host.append(row);
  }
}
function renderWorkshopPanel(){
  const host=$('shopItems');
  const task=selfPlayer.workshopTask;
  const info=document.createElement('div');info.className='bank-market-note';
  info.textContent='🛠️ در کارگاه سفارش بگیر، کار را انجام بده و بعد از آماده‌شدن سفارش، دستمزد سکه‌ای دریافت کن.';
  host.append(info);
  if(!task){
    const tasks=[['lamp','💡 تعمیر چراغ','۶ ثانیه · ۱۴ سکه'],['chair','🪑 ساخت صندلی','۱۰ ثانیه · ۲۲ سکه'],['cart','🛒 تعمیر چرخ‌دستی','۸ ثانیه · ۱۸ سکه'],['shelf','🗄️ ساخت قفسه','۱۴ ثانیه · ۳۰ سکه']];
    tasks.forEach(([taskId,label,detail])=>{const start=document.createElement('button');start.textContent=`${label} · ${detail}`;start.addEventListener('click',()=>socket.emit('workshopTaskStart',{taskId},r=>{showToast(r?.message||'سفارش شروع نشد.',!r?.ok);if(r?.ok)renderShopModal()}));host.append(start)});
    return;
  }
  const taskLine=document.createElement('p');taskLine.className='shop-worker-status';taskLine.textContent=`سفارش فعلی: ${task.label}`;host.append(taskLine);
  const finish=document.createElement('button');
  const remaining=Math.max(0,Math.ceil((task.endsAt-Date.now())/1000));
  finish.textContent=remaining>0?`در حال انجام… ${faNumber(remaining)} ثانیه`:`✅ تحویل سفارش و دریافت ${faNumber(task.reward)} سکه`;
  finish.disabled=remaining>0;
  finish.addEventListener('click',()=>socket.emit('workshopTaskFinish',{},r=>{showToast(r?.message||'تحویل انجام نشد.',!r?.ok);if(r?.ok)renderShopModal()}));
  host.append(finish);
  if(remaining>0)window.setTimeout(()=>{if(!$('shopModal').hidden)renderShopModal()},Math.min(1000,remaining*1000));
}
function renderShopModal(){
  if($('shopModal').hidden || !selfPlayer || !latestState)return;
  const shop=latestState.shops?.[selfPlayer.floor];
  if(!shop)return;
  const worker=latestState.shopWorkers?.[selfPlayer.floor];
  const isWorker=Boolean(worker && worker.id===selfId);
  $('shopJobActions').replaceChildren();
  $('shopItems').replaceChildren();
  if(!worker){
    $('shopWorkerStatus').textContent='🔒 این فروشگاه بسته است؛ تا وقتی یک بازیکن در آن استخدام نشود، خدمات و خرید فعال نیست.';
    const start=document.createElement('button');start.textContent='👷 استخدام و شروع کار در این مکان';
    start.addEventListener('click',()=>socket.emit('shopWorkStart',{},r=>{showToast(r?.message||'شروع کار انجام نشد.',!r?.ok);if(r?.ok)renderShopModal()}));
    $('shopJobActions').append(start);
    return;
  }
  $('shopWorkerStatus').textContent=isWorker?'✅ تو مسئول این فروشگاه هستی؛ هر خرید مشتری ۳ سکه دستمزد دارد.':`✅ فروشگاه باز است؛ مسئول فروشگاه: ${worker.name}`;
  if(isWorker){
    const quit=document.createElement('button');quit.textContent='استعفا از کار';
    quit.addEventListener('click',()=>socket.emit('shopWorkQuit',{},r=>{showToast(r?.message||'استعفا انجام نشد.',!r?.ok);renderShopModal()}));
    $('shopJobActions').append(quit);
  }
  if(shop.id==='bank'){renderBankPanel();return;}
  if(shop.id==='workshop'){
    if(!isWorker){$('shopItems').textContent='این کارگاه توسط بازیکن دیگری اداره می‌شود؛ برای انجام سفارش باید او استعفا بدهد.';return;}
    renderWorkshopPanel();return;
  }
  if(isWorker)return;
  const items=shopCatalog[shop.id]||[];
  items.forEach(item=>{
    const card=document.createElement('div');card.className='shop-item';
    const info=document.createElement('span');info.textContent=`${item.icon} ${item.name} · ${faNumber(item.price)} سکه`;
    const buy=document.createElement('button');buy.textContent='خرید';buy.onclick=()=>socket.emit('shopBuy',{itemId:item.id},r=>{showToast(r?.message||'خرید انجام نشد.',!r?.ok);if(r?.ok)renderInventory()});
    card.append(info,buy);$('shopItems').append(card);
  });
}
const shopCatalog={
 phone:[{id:'phone',name:'گوشی ساده',icon:'📱',price:80}],
 butcher:[{id:'meat',name:'گوشت',icon:'🥩',price:12},{id:'steak',name:'استیک',icon:'🍖',price:25}],
 pets:[{id:'pet_hat',name:'کلاه حیوانات',icon:'🐾',price:30}],
 market:[{id:'bread',name:'نان',icon:'🍞',price:8},{id:'apple',name:'سیب',icon:'🍎',price:6},{id:'water',name:'آب',icon:'💧',price:5}],
 school:[{id:'uniform',name:'لباس مدرسه',icon:'🎓',price:20}],
 eggs:[{id:'egg',name:'تخم‌مرغ',icon:'🥚',price:7}],
 secondhand:[{id:'coat',name:'کت دست‌دوم',icon:'🧥',price:18},{id:'cap',name:'کلاه',icon:'🧢',price:10}],
 restaurant:[{id:'meal',name:'وعده غذا',icon:'🍲',price:20}],
 weapons:[{id:'hotel_sword',name:'شمشیر هتل',icon:'🗡️',price:65}]
};
function renderInventory(){
  if(!selfPlayer)return;
  const host=$('inventoryItems');host.replaceChildren();const items=selfPlayer.inventory||[];
  if(!items.length){host.textContent='کیفت خالی است. از فروشگاه‌ها وسیله بخر.';return}
  items.forEach(item=>{
    const row=document.createElement('div');row.className='shop-item';
    const name=document.createElement('span');name.textContent=`${item.icon} ${item.name}`;
    const use=document.createElement('button');
    use.textContent=item.kind==='food'?'بخور':item.kind==='clothes'?'بپوش':item.kind==='weapon'?'مجهز کن':item.kind==='phone'?'فعال‌سازی گوشی':'استفاده';
    use.disabled=!['food','clothes','phone','weapon'].includes(item.kind);
    use.onclick=()=>socket.emit('useItem',{itemId:item.id},r=>{showToast(r?.message||'انجام نشد.',!r?.ok);if(r?.ok){if(item.kind==='phone')window.setTimeout(openPhone,180);renderInventory()}});
    row.append(name,use);host.append(row);
  });
}

function updateAdminTargets(){
  const select=$('adminTarget');
  if(!select || !selfPlayer || selfPlayer.role!=='admin' || !latestState)return;
  const prior=select.value;select.replaceChildren();
  const targets=latestState.players.filter(person=>person.online);
  const blank=document.createElement('option');blank.value='';blank.textContent=targets.length?'انتخاب بازیکن':'بازیکن آنلاینی نیست';select.append(blank);
  targets.forEach(person=>{const option=document.createElement('option');option.value=person.id;option.textContent=`${person.id===selfId?'خودم · ':''}${person.name} · طبقه ${floorTitle(person.floor)}`;select.append(option)});
  if(targets.some(person=>person.id===prior))select.value=prior;
  select.onchange=()=>updateAdminTargets();
  $('adminKickButton').disabled=!targets.some(p=>p.id!==selfId&&p.id===select.value);
  if($('adminBanButton'))$('adminBanButton').disabled=!targets.some(p=>p.id!==selfId&&p.id===select.value);
  if($('adminFillHungerButton'))$('adminFillHungerButton').disabled=!select.value;
  if($('adminFillHealthButton'))$('adminFillHealthButton').disabled=!select.value;
}

function openPhone(){
  if(!selfPlayer?.hasPhone){showToast('اول گوشی را از فروشگاه بخر و در اینونتوری فعال کن.',true);return}
  $('phoneStatusText').textContent=`گوشی فعال است · طبقه ${floorTitle(selfPlayer.floor)}`;
  $('phoneContacts').textContent='برای دیدن هم‌طبقه‌ای‌های آنلاین، مخاطبین را بزن.';
  $('phoneModal').hidden=false;
}

function refreshPhoneContacts(){
  const host=$('phoneContacts');host.replaceChildren();
  const contacts=(latestState?.players||[]).filter(person=>person.online&&person.floor===selfPlayer?.floor&&person.id!==selfId);
  if(!contacts.length){host.textContent='فعلاً مخاطب آنلاینی در طبقه تو نیست.';return}
  contacts.forEach(person=>{const row=document.createElement('div');row.className='shop-item';row.textContent=`👤 ${person.name}${person.role==='guard'?' · گارد':''}${person.role==='admin'?' · ادمین':''}`;host.append(row)});
}

function appendChatMessage(packet){
  const host=$('chatMessages');
  const empty=host.querySelector('.chat-empty');if(empty)empty.remove();
  const row=document.createElement('div');row.className='chat-message';
  const meta=document.createElement('small');
  const time=new Date(packet.at||Date.now()).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'});
  meta.textContent=`${packet.name}${packet.role?` · ${packet.role}`:''} · ${time}`;
  const body=document.createElement('p');body.textContent=packet.message;
  row.append(meta,body);host.append(row);
  while(host.children.length>60)host.removeChild(host.firstChild);
  host.scrollTop=host.scrollHeight;
}

function toggleChat(open=true){
  $('chatPanel').hidden=!open;
  if(open){$('chatFloorLabel').textContent=`چت مخصوص طبقه ${floorTitle(selfPlayer?.floor??1)} · پیام‌ها عمومی همین طبقه‌اند.`;$('chatInput').focus()}
}


function updateHousePanel(state = latestState) {
  if (!selfPlayer || !state) return;
  const select = $('housePartnerSelect');
  const previous = select.value;
  const roomIds = new Set((activeHouseRoom?.players || []).map(p => p.id));
  const partners = state.players.filter((person) => person.id !== selfId && person.floor === selfPlayer.floor && person.online && (!person.inHouse || roomIds.has(person.id)) && !roomIds.has(person.id));
  select.replaceChildren();
  if (!partners.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'هم‌طبقه‌ای آنلاین پیدا نشد';
    select.appendChild(option);
  } else {
    for (const person of partners) {
      const option = document.createElement('option');
      option.value = person.id;
      option.textContent = person.name;
      select.appendChild(option);
    }
    if (partners.some((person) => person.id === previous)) select.value = previous;
  }
  $('invitePartnerBtn').disabled = partners.length === 0 || Boolean(activeHouseRoom && activeHouseRoom.players.length >= 4);
  $('houseStatus').textContent = activeHouseRoom
    ? `خانه‌ات ${faNumber(activeHouseRoom.players.length)} نفر دارد؛ می‌توانی تا ۴ نفر دوست دعوت کنی.`
    : partners.length ? `در طبقه ${floorTitle(selfPlayer.floor)}، ${faNumber(partners.length)} هم‌طبقه‌ای آنلاین داری.` : 'برای خانه مشترک باید یک هم‌طبقه‌ای آنلاین در همین طبقه باشد.';
}

function makeRoom(slot, occupant) {
  const room = document.createElement('div');
  room.className = `room ${occupant ? 'occupied' : 'empty'}`;
  if (occupant && occupant.id === selfId) room.classList.add('me');
  if (occupant && !occupant.online) room.classList.add('reserved');
  room.setAttribute('aria-label', occupant
    ? `خانه ${faNumber(slot + 1)}: ${occupant.name}${occupant.online ? '' : ' (رزرو آفلاین)'}`
    : `خانه خالی ${faNumber(slot + 1)}`);

  const windowShape = document.createElement('span');
  windowShape.className = 'room-window';
  room.appendChild(windowShape);

  if (occupant) {
    const figure = document.createElement('span');
    figure.className = 'room-figure';
    figure.style.setProperty('--avatar-color', occupant.color || '#d39b64');
    const name = document.createElement('span');
    name.className = 'room-name';
    name.textContent = occupant.id === selfId ? `${occupant.name} (تو)` : occupant.name;
    const status = document.createElement('span');
    status.className = 'room-status';
    status.textContent = occupant.online ? 'آنلاین' : 'رزرو';
    room.append(figure, name, status);
  } else {
    const emptyLabel = document.createElement('span');
    emptyLabel.className = 'empty-room-label';
    emptyLabel.textContent = 'خالی';
    room.appendChild(emptyLabel);
  }
  return room;
}

function makeFloorRow(floor, people, shop, zombie) {
  const row = document.createElement('section');
  row.className = 'floor-row';
  row.id = `floor-row-${floor < 0 ? `m${Math.abs(floor)}` : floor}`;
  row.dataset.floor = String(floor);
  if (floor === selfPlayer.floor) row.classList.add('mine');
  if (floor < 0) row.classList.add('negative-floor');
  if (floor > selfPlayer.maxFloor && !['guard','admin'].includes(selfPlayer.role)) row.classList.add('above');
  if (floor === 0 && !selfPlayer.hasKey) row.classList.add('locked-floor');
  if (floor === 1) row.classList.add('key-floor');

  const number = document.createElement('span');
  number.className = 'floor-number';
  number.textContent = floor < 0 ? `−${faNumber(Math.abs(floor))}` : faNumber(floor);
  row.appendChild(number);

  const label = document.createElement('span');
  label.className = 'floor-label';
  if (floor === selfPlayer.floor) label.textContent = 'طبقه تو';
  else if (floor === selfPlayer.maxFloor) label.textContent = 'حد بالای تو';
  else if (floor === 0) label.textContent = selfPlayer.hasKey ? 'در باز است' : 'درِ قفل‌دار';
  else if (floor < 0) label.textContent = 'جاذبه برعکس';
  row.appendChild(label);

  const roomArea = document.createElement('div');
  roomArea.className = 'room-area';
  for (let slot = 0; slot < 4; slot += 1) roomArea.appendChild(makeRoom(slot, people[slot] || null));
  row.appendChild(roomArea);

  const lift = document.createElement('div');
  lift.className = 'lift-cell';
  const shaft = document.createElement('div');
  shaft.className = 'lift-shaft';
  const door = document.createElement('div');
  door.className = `lift-door${floor === selfPlayer.floor ? ' current' : ''}`;
  door.textContent = floor === selfPlayer.floor ? '●' : 'Ⅱ';
  shaft.appendChild(door);
  lift.appendChild(shaft);

  const move = document.createElement('button');
  move.type = 'button';
  move.className = 'move-btn';
  move.textContent = floor === selfPlayer.floor ? 'اینجایی' : (floor > selfPlayer.floor ? '↑ برو' : '↓ برو');
  move.disabled = floor === selfPlayer.floor
    || (floor > selfPlayer.maxFloor && !['guard','admin'].includes(selfPlayer.role))
    || (floor < 0 && (!selfPlayer.hasKey || selfPlayer.floor > 0))
    || (floor === 0 && !selfPlayer.hasKey);
  if (floor === selfPlayer.floor) move.setAttribute('aria-current', 'location');
  move.addEventListener('click', () => moveToFloor(floor));
  lift.appendChild(move);
  row.appendChild(lift);

  const count = document.createElement('span');
  count.className = 'floor-count';
  count.textContent = `${faNumber(people.length)} از ۴`;
  row.appendChild(count);

  if (shop) {
    const shopBadge = document.createElement('button');
    shopBadge.type='button'; shopBadge.className = 'shop-badge';
    shopBadge.textContent = `${shop.icon} ${shop.name}${floor===selfPlayer.floor?' · ورود':''}`;
    shopBadge.title = `مغازه ثابت این طبقه: ${shop.name}`;
    shopBadge.disabled=floor!==selfPlayer.floor;
    shopBadge.addEventListener('click',()=>openShop(shop));
    row.appendChild(shopBadge);
  }

  if (floor === 1) {
    const keyButton = document.createElement('button');
    keyButton.type = 'button';
    keyButton.className = 'key-button';
    keyButton.textContent = selfPlayer.hasKey ? '✓ کلید برداشته شد' : '🗝 برداشتن کلید';
    keyButton.disabled = selfPlayer.floor !== 1 || selfPlayer.hasKey;
    keyButton.addEventListener('click', collectKey);
    row.appendChild(keyButton);
  }

  if (floor < 0) {
    const special = document.createElement('span');
    special.className = 'floor-special';
    special.textContent = '↑ سقف = زمین';
    row.appendChild(special);
    if (zombie?.active) {
      const zombieBadge = document.createElement('span');
      zombieBadge.className = 'zombie-badge';
      zombieBadge.textContent = '🧟 زامبی در راهرو';
      row.appendChild(zombieBadge);
      if (floor === selfPlayer.floor) {
        const escapeButton = document.createElement('button');
        escapeButton.type = 'button';
        escapeButton.className = 'zombie-escape-btn';
        escapeButton.textContent = `🚪 فرار به ${floorTitle(floor + 1)}`;
        escapeButton.addEventListener('click', () => moveToFloor(floor + 1));
        row.appendChild(escapeButton);
      }
    }
  }
  return row;
}

function renderBuilding(state) {
  if (!selfPlayer) return;
  const occupants = new Map();
  for (const person of state.players) {
    if (!occupants.has(person.floor)) occupants.set(person.floor, []);
    occupants.get(person.floor).push(person);
  }
  const rows = [];
  const zombiesByFloor = new Map((state.zombies || []).map((zombie) => [zombie.floor, zombie]));
  for (let floor = 24; floor >= -3; floor -= 1) {
    rows.push(makeFloorRow(floor, occupants.get(floor) || [], state.shops?.[floor] || null, zombiesByFloor.get(floor)));
  }
  building.replaceChildren(...rows);
}

function updateWorld(state) {
  if (!state || !Array.isArray(state.players)) return;
  latestState = state;
  onlineCount.textContent = faNumber(state.online || 0);
  if (!selfId) return;

  const updated = state.players.find((person) => person.id === selfId);
  if (!updated) {
    // During a reconnect, the first snapshot can arrive before the resume callback.
    // Keep the local token until the server explicitly confirms that the reservation expired.
    return;
  }

  const oldFloor = previousFloor;
  if (oldFloor !== null && oldFloor !== updated.floor && voiceStream) stopVoiceChat(false);
  selfPlayer = updated;
  if (updated.parkPos) parkPosition = { x: updated.parkPos.x, z: updated.parkPos.z };
  if (!$('parkModal').hidden) drawParkScene();
  updatePlayerPanel();
  if (!$('inventoryModal').hidden) renderInventory();
  if (!$('shopModal').hidden) renderShopModal();
  if (chatFloor !== selfPlayer.floor) {
    chatFloor = selfPlayer.floor;
    $('chatMessages').replaceChildren();
    const note=document.createElement('p');note.className='chat-empty';note.textContent=`به چت طبقه ${floorTitle(chatFloor)} خوش آمدی.`;$('chatMessages').append(note);
    if (!$('phoneModal').hidden) refreshPhoneContacts();
  }
  renderBuilding(state);
  updateHousePanel(state);
  if (oldFloor !== null && oldFloor !== selfPlayer.floor) {
    const targetRow = $(`floor-row-${selfPlayer.floor < 0 ? `m${Math.abs(selfPlayer.floor)}` : selfPlayer.floor}`);
    if (targetRow) targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  previousFloor = selfPlayer.floor;
}

function completeJoin(response, resumed = false) {
  selfId = response.playerId;
  selfPlayer = response.player;
  previousFloor = selfPlayer.floor;
  localStorage.setItem(TOKEN_KEY, response.playerId);
  localStorage.setItem(NAME_KEY, selfPlayer.name);
  localStorage.setItem(FLOOR_KEY, String(selfPlayer.maxFloor || selfPlayer.floor));
  $('playerName').value = selfPlayer.name;
  joinScreen.hidden = true;
  gameScreen.hidden = false;
  $('resumeOldButton').hidden = true;
  localStorage.removeItem(MANUAL_LOGOUT_KEY);
  updatePlayerPanel();
  if (latestState) {
    renderBuilding(latestState);
    updateHousePanel(latestState);
  }
  $('bottomHint').textContent = 'می‌توانی بین طبقه انتخابی خودت و طبقات پایین‌تر رفت‌وآمد کنی؛ بالاتر از طبقه شروع نمی‌توانی بروی. در طبقات منفی زامبی هست؛ با دکمه فرار به آسانسور برگرد. پس از ۲۴ ساعت جایگاه آزاد می‌شود، اما حساب و وسایلت باقی می‌مانند و برای ورود دوباره باید طبقه انتخاب کنی.';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  showToast(resumed ? `خوش برگشتی ${selfPlayer.name}!` : `به هتل خوش آمدی ${selfPlayer.name}!`);
  pendingNameOffers = Array.isArray(response.nameOffers) ? response.nameOffers : pendingNameOffers;
  renderNameOffers();
  if (response.recoveryCode) showRecoveryCode(response.recoveryCode, 'کد بازیابی حساب جدید');
}

function showRecoveryCode(code, title = 'کد بازیابی') {
  $('recoveryTitle').textContent = title;
  $('recoveryFormArea').hidden = true;
  $('recoveryCodeResult').hidden = false;
  $('recoveryCodeDisplay').textContent = code;
  $('recoveryModal').hidden = false;
}

function openRecoveryForm() {
  $('recoveryTitle').textContent = 'بازیابی حساب با کد';
  $('recoveryFormArea').hidden = false;
  $('recoveryCodeResult').hidden = true;
  $('recoveryName').value = $('playerName').value.trim();
  $('recoveryCodeInput').value = '';
  $('recoveryNewPassword').value = '';
  $('recoveryModal').hidden = false;
}

function openNameMarket() {
  if (!selfId) return;
  $('nameMarketItems').replaceChildren();
  const loading = document.createElement('p'); loading.textContent = 'در حال دریافت نام‌های قابل معامله…'; $('nameMarketItems').append(loading);
  $('nameMarketModal').hidden = false;
  socket.emit('nameMarketList', {}, response => {
    if (!response?.ok) { loading.textContent = response?.message || 'بازار نام‌ها باز نشد.'; return; }
    const host = $('nameMarketItems'); host.replaceChildren();
    if (!response.entries.length) { host.textContent = 'فعلاً نام دیگری برای خرید وجود ندارد.'; return; }
    response.entries.forEach(person => {
      const row = document.createElement('div'); row.className = 'shop-item';
      const label = document.createElement('span');
      label.textContent = `🏷️ ${person.name} · ${person.online ? 'آنلاین' : 'آفلاین'}`;
      const buy = document.createElement('button'); buy.textContent = 'پیشنهاد خرید';
      buy.addEventListener('click', () => {
        const raw = window.prompt(`برای نام «${person.name}» چند سکه پیشنهاد می‌دهی؟`, '20');
        if (raw === null) return;
        const price = Number(raw);
        if (!Number.isInteger(price) || price < 1) { showToast('قیمت باید یک عدد صحیح مثبت باشد.', true); return; }
        socket.emit('nameOfferCreate', { targetId: person.id, price }, result => {
          showToast(result?.message || 'ارسال پیشنهاد انجام نشد.', !result?.ok);
          if (result?.ok) openNameMarket();
        });
      });
      row.append(label, buy); host.append(row);
    });
  });
}

function renderNameOffers() {
  const host = $('nameOffersItems'); if (!host) return;
  $('nameOffersModal').hidden = !pendingNameOffers.length;
  host.replaceChildren();
  if (!pendingNameOffers.length) { host.textContent = 'پیشنهاد خرید نامی نداری.'; return; }
  pendingNameOffers.forEach(offer => {
    const row = document.createElement('div'); row.className = 'shop-item name-offer-row';
    const info = document.createElement('span'); info.textContent = `${offer.fromName} برای نام «${offer.targetName}» ${faNumber(offer.price)} سکه پیشنهاد داده است.`;
    const actions = document.createElement('div'); actions.className = 'name-offer-actions';
    const accept = document.createElement('button'); accept.textContent = 'قبول';
    const decline = document.createElement('button'); decline.textContent = 'رد';
    accept.addEventListener('click', () => respondNameOffer(offer.id, true));
    decline.addEventListener('click', () => respondNameOffer(offer.id, false));
    actions.append(accept, decline); row.append(info, actions); host.append(row);
  });
}

function respondNameOffer(offerId, accept) {
  socket.emit('nameOfferRespond', { offerId, accept }, response => {
    showToast(response?.message || 'پاسخ ثبت نشد.', !response?.ok);
    if (response?.ok) {
      pendingNameOffers = pendingNameOffers.filter(item => item.id !== offerId);
      renderNameOffers();
    }
  });
}

function showLoginScreenAfterLogout() {
  selfId = null; selfPlayer = null; previousFloor = null; activeHouseRoom = null;
  localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(NAME_KEY); localStorage.removeItem(FLOOR_KEY); localStorage.removeItem(MANUAL_LOGOUT_KEY);
  $('gameScreen').hidden = true; $('joinScreen').hidden = false; $('resumeOldButton').hidden = true;
  $('accountPassword').value = '';
}

function tryResume(force = false) {
  if (!force && localStorage.getItem(MANUAL_LOGOUT_KEY) === '1') return;
  const token = localStorage.getItem(TOKEN_KEY);
  const name = localStorage.getItem(NAME_KEY);
  if (!token || !name || !socket.connected || resumeInProgress || resumeAttemptedForSocket) return;
  resumeInProgress = true;
  resumeAttemptedForSocket = true;
  socket.emit('join', {
    token,
    name,
    floor: Number(localStorage.getItem(FLOOR_KEY)) || 12,
    resumeOnly: true
  }, (response) => {
    resumeInProgress = false;
    if (response?.ok) {
      completeJoin(response, true);
      return;
    }
    if (response?.expired) {
      selfId = null;
      selfPlayer = null;
      previousFloor = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(NAME_KEY);
      localStorage.removeItem(FLOOR_KEY);
      $('playerName').value = name;
      showJoinError(response.message || 'رزرو قبلی تمام شده؛ دوباره طبقه انتخاب کن.');
      joinScreen.hidden = false;
      gameScreen.hidden = true;
    } else if (response?.message) {
      showToast(response.message, true);
    }
  });
}

function moveToFloor(floor) {
  socket.emit('moveFloor', { floor }, (response) => {
    if (!response || !response.ok) {
      showToast(response?.message || 'حرکت انجام نشد.', true);
      return;
    }
    showToast(response.message || 'به طبقه جدید رسیدی.');
  });
}

function collectKey() {
  socket.emit('collectKey', {}, (response) => {
    showToast(response?.message || 'کلید دریافت نشد.', !response?.ok);
  });
}

const CABINET_GAMES=[
  {id:'chess',icon:'♟️',name:'شطرنج',gameId:'puzzle'},
  {id:'ludo',icon:'🎲',name:'منچ',gameId:'race'},
  {id:'cards',icon:'🃏',name:'کارت‌بازی',gameId:'record'},
  {id:'football',icon:'⚽',name:'فوتبال رومیزی',gameId:'football'},
  {id:'pingpong',icon:'🏓',name:'پینگ‌پنگ',gameId:'pingpong'},
  {id:'basketball',icon:'🏀',name:'بسکتبال رومیزی',gameId:'basketball'}
];
function drawHouse3D(room){
  const canvas=$('house3dCanvas');if(!canvas||!room)return;
  const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);
  const poly=(pts,fill,stroke='#78664b')=>{ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle=stroke;ctx.lineWidth=3;ctx.stroke()};
  // Two walls and a perspective wooden floor.
  poly([[105,58],[480,18],[860,78],[480,190]],'#e9d9b8','#9a825c');
  poly([[105,58],[480,190],[480,405],[105,270]],'#c7b18c','#8f7858');
  poly([[480,190],[860,78],[860,300],[480,405]],'#ddcba8','#8f7858');
  poly([[105,270],[480,405],[860,300],[480,190]],'#a8794f','#75553a');
  for(let i=0;i<7;i++){const y=285+i*17;ctx.strokeStyle='#7a553b66';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(150,y);ctx.lineTo(480,y+85);ctx.lineTo(820,y+25);ctx.stroke()}
  // Window and curtains.
  poly([[210,92],[340,128],[340,211],[210,171]],'#9bc8d0','#79684c');ctx.strokeStyle='#fff2ce';ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(275,110);ctx.lineTo(275,190);ctx.stroke();
  ctx.fillStyle='#7b4d3c';ctx.fillRect(195,83,10,96);ctx.fillRect(343,126,9,91);
  // Sofa.
  poly([[535,260],[690,205],[775,237],[620,296]],'#5c8068','#3e5d47');
  poly([[535,260],[620,296],[620,340],[535,304]],'#496c55','#3e5d47');
  poly([[620,296],[775,237],[775,277],[620,340]],'#6e9477','#3e5d47');
  // Cabinet on left wall with game boxes.
  poly([[155,208],[245,240],[245,330],[155,296]],'#805a3c','#533a2a');
  poly([[155,208],[245,240],[277,222],[188,190]],'#ad8052','#533a2a');
  for(let i=0;i<3;i++){ctx.strokeStyle='#e6c18a';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(166,230+i*26);ctx.lineTo(234,253+i*26);ctx.stroke()}
  // Table in center.
  poly([[350,270],[485,225],[595,265],[455,315]],'#d9b17a','#805a38');
  poly([[350,270],[455,315],[455,351],[350,305]],'#8c603b','#68452d');
  poly([[455,315],[595,265],[595,301],[455,351]],'#a97849','#68452d');
  if(room.tableGame){ctx.save();ctx.translate(472,266);ctx.fillStyle='#e8d8b3';ctx.strokeStyle='#6b583f';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(0,0,52,17,-.2,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.font='25px serif';ctx.textAlign='center';ctx.fillText(room.tableGame.icon||'🎲',0,7);ctx.restore()}
  // Rug and floor lamp.
  ctx.fillStyle='#b85e4f';ctx.globalAlpha=.8;ctx.beginPath();ctx.ellipse(475,354,140,35,-.08,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
  ctx.strokeStyle='#5b4c37';ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(790,170);ctx.lineTo(790,260);ctx.stroke();ctx.fillStyle='#f3d886';ctx.beginPath();ctx.arc(790,160,25,Math.PI,0);ctx.fill();
  ctx.fillStyle='#4e4939';ctx.font='bold 17px Vazirmatn, sans-serif';ctx.textAlign='center';ctx.fillText('خانه مشترک',480,440);
}
function renderCabinetBar(room){
  const host=$('houseCabinetBar');host.replaceChildren();
  if(!room.tableGame){
    const title=document.createElement('strong');title.textContent='🗄️ کابینت بازی‌ها؛ یکی را بردار و روی میز بگذار:';host.append(title);
    CABINET_GAMES.forEach(item=>{const b=document.createElement('button');b.type='button';b.textContent=`${item.icon} ${item.name}`;b.addEventListener('click',()=>socket.emit('houseCabinetPlace',{gameId:item.id},r=>showToast(r?.message||'روی میز گذاشته نشد.',!r?.ok)));host.append(b)});
  }else{
    const title=document.createElement('strong');title.textContent=`روی میز: ${room.tableGame.icon} ${room.tableGame.name}`;host.append(title);
    const remove=document.createElement('button');remove.className='cabinet-remove';remove.textContent='برداشتن از میز و بازگرداندن به کابینت';remove.addEventListener('click',()=>socket.emit('houseCabinetRemove',{},r=>showToast(r?.message||'انجام نشد.',!r?.ok)));host.append(remove);
  }
}
function renderHouseRoom(room) {
  activeHouseRoom = room;
  $('houseRoomPanel').hidden = !room;
  updateHousePanel(latestState);
  if (!room) {
    if (miniGameTimerInterval) window.clearInterval(miniGameTimerInterval);
    miniGameTimerInterval = null;
    return;
  }
  const names = room.players.map((person) => person.id === selfId ? `${person.name} (تو)` : person.name);
  $('housePlayersLine').textContent = `طبقه ${floorTitle(room.floor)} • ${names.join(' و ')}`;
  drawHouse3D(room);renderCabinetBar(room);
  const choices = $('miniGameChoices');choices.replaceChildren();
  const selected = room.tableGame;
  const gameChoice = selected ? MINI_GAMES.find(g=>g.id===selected.gameId) : null;
  if(gameChoice){
    const card=document.createElement('button');card.type='button';card.className='mini-game-card';
    const icon=document.createElement('span');icon.className='mini-game-card-icon';icon.textContent=gameChoice.icon;
    const title=document.createElement('strong');title.textContent=`شروع ${gameChoice.title}`;
    const description=document.createElement('small');description.textContent='وسیله روی میز قرار دارد؛ با دوستت بازی را شروع کن.';
    card.append(icon,title,description);card.addEventListener('click',()=>socket.emit('miniGameStart',{gameId:gameChoice.id},response=>{if(!response?.ok)showToast(response?.message||'شروع بازی نشد.',true)}));choices.append(card);
  }
  const game = room.game;
  $('miniGameStage').hidden = !game;
  choices.hidden = !selected || Boolean(game && !game.ended);
  if (!game) return;
  $('miniGameTitle').textContent = `${game.icon} ${game.title}`;
  $('miniGameDescription').textContent = game.description;
  const scores = $('miniGameScores');scores.replaceChildren();
  for (const player of game.scores) {
    const item = document.createElement('div');item.className = 'mini-game-score';
    const name = document.createElement('span');name.textContent = player.id === selfId ? `${player.name} (تو)` : player.name;
    const score = document.createElement('strong');score.textContent = faNumber(player.score);item.append(name, score);scores.appendChild(item);
  }
  const question = $('miniGameQuestion');question.replaceChildren();
  if (game.gameId === 'puzzle' && game.question && !game.ended) {
    question.hidden = false;const prompt = document.createElement('strong');prompt.textContent = game.question.text;question.appendChild(prompt);
    game.question.options.forEach((option, index) => {const answer = document.createElement('button');answer.type = 'button';answer.className = 'puzzle-answer';answer.textContent = option;answer.addEventListener('click', () => submitMiniGameAction({ answerIndex: index }));question.appendChild(answer)});
  } else question.hidden = true;
  $('miniGameAction').textContent = game.action;$('miniGameAction').hidden = game.gameId === 'puzzle' || game.ended;
  $('miniGameAgain').hidden = !game.ended;
  $('miniGameAgain').onclick = () => socket.emit('miniGameStart', { gameId: game.gameId }, (response) => {if (!response?.ok) showToast(response?.message || 'شروع دوباره انجام نشد.', true)});
  if (game.ended) { $('miniGameTimer').textContent = game.resultText || 'بازی تمام شد';$('miniGameDescription').textContent = game.resultText || 'بازی تمام شد!'; }
  else { updateMiniGameTimer(game.endsAt);if (miniGameTimerInterval) window.clearInterval(miniGameTimerInterval);miniGameTimerInterval = window.setInterval(() => updateMiniGameTimer(game.endsAt), 250); }
}

function updateMiniGameTimer(endsAt) {
  const seconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  $('miniGameTimer').textContent = `${faNumber(seconds)} ثانیه مانده`;
}

function submitMiniGameAction(payload = {}) {
  socket.emit('miniGameAction', payload, (response) => {
    if (!response?.ok) showToast(response?.message || 'حرکت ثبت نشد.', true);
    else showToast(response.message || 'ثبت شد.');
  });
}

$('invitePartnerBtn').addEventListener('click', () => {
  const targetId = $('housePartnerSelect').value;
  if (!targetId) return;
  socket.emit('houseInvite', { targetId }, (response) => showToast(response?.message || 'دعوت فرستاده نشد.', !response?.ok));
});

$('acceptHouseInvite').addEventListener('click', () => {
  if (!pendingHouseInviteId) return;
  socket.emit('houseInviteRespond', { inviteId: pendingHouseInviteId, accept: true }, (response) => {
    $('houseInviteModal').hidden = true;
    pendingHouseInviteId = null;
    showToast(response?.message || 'ورود به خانه انجام نشد.', !response?.ok);
  });
});
$('declineHouseInvite').addEventListener('click', () => {
  if (!pendingHouseInviteId) return;
  socket.emit('houseInviteRespond', { inviteId: pendingHouseInviteId, accept: false }, (response) => {
    $('houseInviteModal').hidden = true;
    pendingHouseInviteId = null;
    if (!response?.ok) showToast(response?.message || 'دعوت رد نشد.', true);
  });
});
$('leaveHouseBtn').addEventListener('click', () => {
  socket.emit('houseLeave', {}, (response) => showToast(response?.message || 'خروج از خانه انجام نشد.', !response?.ok));
});
$('miniGameAction').addEventListener('click', () => submitMiniGameAction());

socket.on('houseInviteReceived', (invite) => {
  pendingHouseInviteId = invite.inviteId;
  $('houseInviteText').textContent = `${invite.from.name} از طبقه ${floorTitle(invite.from.floor)} دعوتت کرده وارد خانه مشترک بشی و مینی‌گیم بازی کنید.`;
  $('houseInviteModal').hidden = false;
});
socket.on('houseInviteResult', (result) => showToast(result.message || 'نتیجه دعوت دریافت شد.'));
socket.on('houseRoomState', (room) => renderHouseRoom(room));
socket.on('houseRoomClosed', (result) => {
  renderHouseRoom(null);
  showToast(result?.message || 'خانه مشترک بسته شد.');
});

// ---------- Isometric 3D-style park ----------
function isoPoint(x,z,y=0){const c=$('parkCanvas');return [c.width/2+(x-z)*23,72+(x+z)*11.8-y*25]}
function parkPolygon(points,fill,stroke=null){const c=$('parkCanvas'),ctx=c.getContext('2d');ctx.beginPath();points.forEach((p,i)=>{const q=isoPoint(p[0],p[1],p[2]||0);i?ctx.lineTo(q[0],q[1]):ctx.moveTo(q[0],q[1])});ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke()}}
function drawTree(x,z,size=1){const ctx=$('parkCanvas').getContext('2d');const [sx,sy]=isoPoint(x,z);ctx.fillStyle='#765034';ctx.beginPath();ctx.moveTo(sx-7*size,sy);ctx.lineTo(sx+8*size,sy);ctx.lineTo(sx+5*size,sy-52*size);ctx.lineTo(sx-4*size,sy-52*size);ctx.fill();
  for(let i=0;i<3;i++){const yy=sy-56*size-i*19*size;ctx.fillStyle=['#3e7948','#4e8b4e','#65994f'][i];ctx.beginPath();ctx.moveTo(sx,yy-32*size);ctx.lineTo(sx-33*size,yy+12*size);ctx.lineTo(sx+34*size,yy+12*size);ctx.closePath();ctx.fill();ctx.strokeStyle='#2d6039';ctx.lineWidth=1;ctx.stroke()}}
function drawParkScene(){
  const canvas=$('parkCanvas');if(!canvas||$('parkModal').hidden)return;const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  const sky=ctx.createLinearGradient(0,0,0,h);sky.addColorStop(0,'#a9d1df');sky.addColorStop(.55,'#dce8cf');sky.addColorStop(1,'#8da56e');ctx.fillStyle=sky;ctx.fillRect(0,0,w,h);
  parkPolygon([[0,0],[20,0],[20,20],[0,20]],'#84a96f','#526b4d');
  // Paved paths and a small plaza.
  parkPolygon([[8,0],[12,0],[12,20],[8,20]],'#c8b995','#9c8c69');
  parkPolygon([[0,8],[20,8],[20,12],[0,12]],'#c8b995','#9c8c69');
  for(let x=8.2;x<12;x+=.9)for(let z=0;z<20;z+=.9)parkPolygon([[x,z],[x+.12,z],[x+.12,z+.12],[x,z+.12]],'#d8c8a7');
  // Flower beds.
  const beds=[[3,3],[17,3],[3,17],[17,17],[6,14],[14,6]];
  beds.forEach(([x,z])=>{parkPolygon([[x-1,z-1],[x+1,z-1],[x+1,z+1],[x-1,z+1]],'#557f4a','#456b3f');for(let j=0;j<7;j++){const px=x+Math.cos(j*6.28/7)*.7,pz=z+Math.sin(j*6.28/7)*.7,[a,b]=isoPoint(px,pz,.15);ctx.fillStyle=['#e6a0a0','#f0d17a','#e6e1c2'][j%3];ctx.beginPath();ctx.arc(a,b,4,0,Math.PI*2);ctx.fill()}});
  // Pond with stone rim and water.
  {const [x,y]=isoPoint(15,14);ctx.fillStyle='#9a8b6a';ctx.beginPath();ctx.ellipse(x,y,95,44,-.38,0,Math.PI*2);ctx.fill();ctx.fillStyle='#5da9bb';ctx.beginPath();ctx.ellipse(x,y-5,82,33,-.38,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#c5e3dc';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(x-10,y-7,42,8,-.38,0,Math.PI*2);ctx.stroke();}
  // Trees and lamps (drawn in depth order).
  const props=[];[[2,2,1.05],[5,3,.9],[18,2,1.05],[2,18,1.1],[18,18,1.08],[5,17,.88],[13,3,.85],[7,7,.8]].forEach(a=>props.push({d:a[0]+a[1],fn:()=>drawTree(...a)}));
  props.sort((a,b)=>a.d-b.d).forEach(o=>o.fn());
  // Benches, lamps and bins.
  function bench(x,z){const [a,b]=isoPoint(x,z);ctx.fillStyle='#79502f';ctx.fillRect(a-27,b-20,55,8);ctx.fillRect(a-24,b-39,48,6);ctx.fillStyle='#534331';ctx.fillRect(a-22,b-14,5,18);ctx.fillRect(a+18,b-14,5,18)}
  [[6,6],[14,5],[6,14],[12,17]].forEach(([x,z])=>bench(x,z));
  [[9,4],[4,10],[16,10],[10,18]].forEach(([x,z])=>{const [a,b]=isoPoint(x,z);ctx.strokeStyle='#454b45';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(a,b);ctx.lineTo(a,b-64);ctx.stroke();ctx.fillStyle='#f7e7a6';ctx.beginPath();ctx.arc(a,b-68,9,0,Math.PI*2);ctx.fill()});
  // Fountain in plaza.
  {const [a,b]=isoPoint(10,10);ctx.fillStyle='#8c9a9a';ctx.beginPath();ctx.ellipse(a,b,61,26,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#6baec0';ctx.beginPath();ctx.ellipse(a,b-5,53,19,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#d6f2ee';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(a,b-8);ctx.quadraticCurveTo(a-8,b-58,a+2,b-72);ctx.stroke();ctx.beginPath();ctx.arc(a+2,b-72,5,0,Math.PI*2);ctx.fill()}
  // Players appear inside the same park.
  const people=(latestState?.players||[]).filter(p=>p.inPark&&p.online);
  people.sort((a,b)=>(a.parkPos?.x+a.parkPos?.z||0)-(b.parkPos?.x+b.parkPos?.z||0));
  people.forEach(person=>{const pos=person.id===selfId?parkPosition:(person.parkPos||{x:10,z:10});const [a,b]=isoPoint(pos.x,pos.z);ctx.fillStyle=person.color||'#e8b46b';ctx.beginPath();ctx.ellipse(a,b-17,9,6,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#6b4b36';ctx.fillRect(a-5,b-41,10,23);ctx.fillStyle='#f2d1ad';ctx.beginPath();ctx.arc(a,b-48,8,0,Math.PI*2);ctx.fill();ctx.fillStyle='#28352b';ctx.font='bold 12px Vazirmatn,sans-serif';ctx.textAlign='center';ctx.fillText(person.id===selfId?`${person.name} (تو)`:person.name,a,b-61)});
  ctx.fillStyle='#233d2c';ctx.font='bold 14px Vazirmatn,sans-serif';ctx.textAlign='right';ctx.fillText('پارک مرکزی هتل ۹۶',w-18,28);
}
function openPark(){
  if(!selfPlayer)return; $('parkModal').hidden=false;
  if(selfPlayer.parkPos)parkPosition={x:selfPlayer.parkPos.x,z:selfPlayer.parkPos.z};
  socket.emit('parkEnter',{},r=>{if(!r?.ok)showToast(r?.message||'ورود به پارک انجام نشد.',true);else showToast(r.message)});
  drawParkScene();if(parkAnimationFrame)cancelAnimationFrame(parkAnimationFrame);
  const tick=()=>{if($('parkModal').hidden){parkAnimationFrame=null;return}drawParkScene();parkAnimationFrame=requestAnimationFrame(tick)};parkAnimationFrame=requestAnimationFrame(tick);
}
function closePark(){
  $('parkModal').hidden=true;if(parkAnimationFrame)cancelAnimationFrame(parkAnimationFrame);parkAnimationFrame=null;
  socket.emit('parkLeave',{},()=>{});
}
function movePark(direction){
  if($('parkModal').hidden)return;const step=.65;
  if(direction==='up')parkPosition.z=Math.max(1,parkPosition.z-step);
  if(direction==='down')parkPosition.z=Math.min(19,parkPosition.z+step);
  if(direction==='left')parkPosition.x=Math.max(1,parkPosition.x-step);
  if(direction==='right')parkPosition.x=Math.min(19,parkPosition.x+step);
  const now=Date.now();if(now-lastParkSentAt>75){lastParkSentAt=now;socket.emit('parkMove',parkPosition,()=>{})}drawParkScene();
}
$('parkButton').addEventListener('click',openPark);
$('parkCloseButton').addEventListener('click',closePark);
$('parkModal').addEventListener('click',e=>{if(e.target===$('parkModal'))closePark()});
document.querySelectorAll('[data-park-move]').forEach(b=>b.addEventListener('click',()=>movePark(b.dataset.parkMove)));
window.addEventListener('keydown',e=>{if($('parkModal').hidden)return;const key=e.key.toLowerCase();const map={w:'up',arrowup:'up',s:'down',arrowdown:'down',a:'left',arrowleft:'left',d:'right',arrowright:'right'};if(map[key]){e.preventDefault();movePark(map[key])}});

// ---------- WebRTC voice chat for the current floor / shared house ----------
function closeVoicePeer(peerId){const pc=voicePeers.get(peerId);if(pc){pc.close();voicePeers.delete(peerId)}const audio=$(`voice-audio-${peerId}`);if(audio)audio.remove()}
function createVoicePeer(peerId,initiate){
  if(!voiceStream||voicePeers.has(peerId))return;
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});pc.pendingCandidates=[];voicePeers.set(peerId,pc);
  voiceStream.getTracks().forEach(track=>pc.addTrack(track,voiceStream));
  pc.onicecandidate=e=>{if(e.candidate)socket.emit('voiceSignal',{targetId:peerId,candidate:e.candidate},()=>{})};
  pc.ontrack=e=>{let audio=$(`voice-audio-${peerId}`);if(!audio){audio=document.createElement('audio');audio.id=`voice-audio-${peerId}`;audio.autoplay=true;audio.playsInline=true;audio.hidden=true;document.body.append(audio)}audio.srcObject=e.streams[0];audio.play().catch(()=>{})};
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))closeVoicePeer(peerId)};
  if(initiate)pc.createOffer().then(offer=>pc.setLocalDescription(offer)).then(()=>socket.emit('voiceSignal',{targetId:peerId,description:pc.localDescription},()=>{})).catch(()=>closeVoicePeer(peerId));
  return pc;
}
async function startVoiceChat(){
  if(!navigator.mediaDevices?.getUserMedia){showToast('مرورگر یا اتصال فعلی اجازه میکروفون نمی‌دهد؛ بازی را با HTTPS باز کن.',true);return}
  try{
    voiceStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    $('voiceToggleButton').textContent='🎙️ ویس‌چت روشن';$('voiceToggleButton').classList.add('voice-on');
    socket.emit('voicePresence',{active:true},r=>{if(!r?.ok)showToast(r?.message||'فعال‌سازی ویس‌چت انجام نشد.',true)});
    const peers=(latestState?.players||[]).filter(p=>p.id!==selfId&&p.online&&p.floor===selfPlayer.floor&&p.voiceActive);
    peers.forEach(p=>{if(String(selfId)<String(p.id))createVoicePeer(p.id,true)});
    showToast('ویس‌چت روشن شد؛ برای شنیدن صدای هم‌طبقه‌ای‌ها باید آن‌ها هم ویس‌چت را روشن کنند.');
  }catch(error){voiceStream=null;showToast('اجازه استفاده از میکروفون داده نشد یا میکروفون در دسترس نیست.',true)}
}
function stopVoiceChat(notify=true){
  for(const id of [...voicePeers.keys()])closeVoicePeer(id);
  if(voiceStream){voiceStream.getTracks().forEach(t=>t.stop());voiceStream=null}
  $('voiceToggleButton').textContent='🎙️ ویس‌چت خاموش';$('voiceToggleButton').classList.remove('voice-on');
  if(notify&&selfId)socket.emit('voicePresence',{active:false},()=>{});
}
$('voiceToggleButton').addEventListener('click',()=>voiceStream?stopVoiceChat(true):startVoiceChat());
socket.on('voicePresence',packet=>{
  if(!packet||packet.playerId===selfId)return;
  if(!packet.active){closeVoicePeer(packet.playerId);return}
  if(voiceStream&&String(selfId)<String(packet.playerId))createVoicePeer(packet.playerId,true);
});
socket.on('voiceSignal',async packet=>{
  if(!voiceStream||!packet?.fromId)return;
  let pc=voicePeers.get(packet.fromId);if(!pc)pc=createVoicePeer(packet.fromId,false);
  try{
    if(packet.description){
      await pc.setRemoteDescription(new RTCSessionDescription(packet.description));
      while(pc.pendingCandidates?.length){const candidate=pc.pendingCandidates.shift();await pc.addIceCandidate(new RTCIceCandidate(candidate))}
      if(packet.description.type==='offer'){const answer=await pc.createAnswer();await pc.setLocalDescription(answer);socket.emit('voiceSignal',{targetId:packet.fromId,description:pc.localDescription},()=>{})}
    }
    if(packet.candidate){if(pc.remoteDescription)await pc.addIceCandidate(new RTCIceCandidate(packet.candidate));else (pc.pendingCandidates ||= []).push(packet.candidate)}
  }catch(error){closeVoicePeer(packet.fromId)}
});
$('inventoryButton').addEventListener('click',()=>{renderInventory();$('inventoryModal').hidden=false;});
$('attackButton').addEventListener('click',()=>{const targetId=$('attackTarget').value;if(!targetId)return;socket.emit('attackPlayer',{targetId},r=>showToast(r?.message||'حمله انجام نشد.',!r?.ok));});
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).hidden=true));
socket.on('playerNotice',data=>showToast(data?.message||'وضعیت بازیکن تغییر کرد.',true));

$('phoneButton').addEventListener('click',openPhone);
$('phoneOpenChat').addEventListener('click',()=>{$('phoneModal').hidden=true;toggleChat(true)});
$('phoneRefreshContacts').addEventListener('click',refreshPhoneContacts);
$('chatToggleButton').addEventListener('click',()=>toggleChat($('chatPanel').hidden));
$('chatCloseButton').addEventListener('click',()=>toggleChat(false));
$('chatForm').addEventListener('submit',(event)=>{
  event.preventDefault();
  const input=$('chatInput');const message=input.value.trim();if(!message)return;
  socket.emit('chatSend',{message},response=>{if(response?.ok)input.value='';else showToast(response?.message||'پیام ارسال نشد.',true)});
});
socket.on('chatMessage',appendChatMessage);
$('guardButton').addEventListener('click',()=>socket.emit('guardPromotion',{},response=>showToast(response?.message||'ارتقای گارد انجام نشد.',!response?.ok)));
$('escapeButton').addEventListener('click',()=>{
  if(!window.confirm('خروج مخفیانه از هتل؟ گارد ممکن است جلویت را بگیرد.'))return;
  socket.emit('escapeAttempt',{},response=>{
    showToast(response?.message||'خروج انجام نشد.',!response?.ok);
    if(response?.ok){
      selfId=null;selfPlayer=null;previousFloor=null;activeHouseRoom=null;
      if (selfPlayer?.hasPassword) { showLoginScreenAfterLogout(); } else {
        localStorage.setItem(MANUAL_LOGOUT_KEY,'1');
        $('gameScreen').hidden=true;$('joinScreen').hidden=false;$('resumeOldButton').hidden=false;
        $('playerName').value=localStorage.getItem(NAME_KEY)||'';
        $('joinError').hidden=true;
      }
    }
  });
});
$('resumeOldButton').addEventListener('click',()=>{
  if(!socket.connected){showJoinError('اول اتصال سرور برقرار شود.');return}
  resumeAttemptedForSocket=false;localStorage.removeItem(MANUAL_LOGOUT_KEY);tryResume(true);
});
$('playerName').addEventListener('input',()=>{
  $('adminCodeRow').hidden=$('playerName').value.trim().toLowerCase()!=='amirxrax';
});
$('adminKickButton').addEventListener('click',()=>{
  const targetId=$('adminTarget').value;if(!targetId||targetId===selfId)return showToast('برای خارج کردن، بازیکن دیگری را انتخاب کن.',true);
  if(!window.confirm('این بازیکن از بازی خارج شود؟'))return;
  socket.emit('adminKick',{targetId},response=>showToast(response?.message||'عملیات انجام نشد.',!response?.ok));
});
$('adminBanButton').addEventListener('click',()=>{
  const targetId=$('adminTarget').value;if(!targetId||targetId===selfId)return showToast('ادمین نمی‌تواند خودش را بن کند.',true);
  if(!window.confirm('این حساب برای همیشه از ورود به بازی مسدود شود؟'))return;
  socket.emit('adminBan',{targetId},response=>showToast(response?.message||'بن انجام نشد.',!response?.ok));
});
$('adminFillHungerButton').addEventListener('click',()=>{
  const targetId=$('adminTarget').value;if(!targetId)return;
  socket.emit('adminFillStat',{targetId,stat:'hunger'},r=>showToast(r?.message||'غذا پر نشد.',!r?.ok));
});
$('adminFillHealthButton').addEventListener('click',()=>{
  const targetId=$('adminTarget').value;if(!targetId)return;
  socket.emit('adminFillStat',{targetId,stat:'health'},r=>showToast(r?.message||'جون پر نشد.',!r?.ok));
});
$('adminFloor24Button').addEventListener('click',()=>{
  const unlocked=latestState?.floor24Unlocked===false;
  socket.emit('adminFloor24Toggle',{unlocked},r=>showToast(r?.message||'تغییر قفل انجام نشد.',!r?.ok));
});
socket.on('adminNotice',data=>{
  showToast(data?.message||'از بازی خارج شدی.',true);
  if(selfId){if(selfPlayer?.hasPassword){showLoginScreenAfterLogout()}else{localStorage.setItem(MANUAL_LOGOUT_KEY,'1');$('resumeOldButton').hidden=false;$('playerName').value=selfPlayer?.name||'';$('gameScreen').hidden=true;$('joinScreen').hidden=false;selfId=null;selfPlayer=null;previousFloor=null}}
});

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  joinError.hidden = true;
  if (!socket.connected) { showJoinError('هنوز به سرور وصل نشده‌ای. اول سرور را روشن کن و دوباره تلاش کن.'); return; }
  const name = $('playerName').value.trim();
  const password = $('accountPassword').value;
  const floor = Number(floorChoice.value);
  const submit = joinForm.querySelector('button[type="submit"]');
  submit.disabled = true; submit.textContent = 'در حال ساخت حساب…';
  socket.emit('accountRegister', { name, password, floor, adminCode: $('adminCode').value }, response => {
    submit.disabled = false; submit.innerHTML = 'ساخت حساب و ورود <span>←</span>';
    if (!response?.ok) { showJoinError(response?.message || 'ساخت حساب انجام نشد.'); return; }
    completeJoin(response, false);
  });
});

$('accountLoginButton').addEventListener('click', () => {
  joinError.hidden = true;
  if (!socket.connected) return showJoinError('سرور هنوز وصل نشده است.');
  const name = $('playerName').value.trim(); const password = $('accountPassword').value; const floor = Number(floorChoice.value);
  if (!name || !password) return showJoinError('نام کاربری و رمز را وارد کن.');
  $('accountLoginButton').disabled = true;
  socket.emit('accountLogin', { name, password, floor }, response => {
    $('accountLoginButton').disabled = false;
    if (!response?.ok) return showJoinError(response?.message || 'ورود انجام نشد.');
    completeJoin(response, true);
  });
});

$('accountRecoverButton').addEventListener('click', openRecoveryForm);
$('recoverySubmitButton').addEventListener('click', () => {
  const name = $('recoveryName').value.trim(); const recoveryCode = $('recoveryCodeInput').value.trim(); const newPassword = $('recoveryNewPassword').value;
  socket.emit('accountRecover', { name, recoveryCode, newPassword }, response => {
    if (!response?.ok) { showToast(response?.message || 'بازیابی انجام نشد.', true); return; }
    showToast(response.message || 'رمز تغییر کرد.');
    $('playerName').value = name; $('accountPassword').value = newPassword;
    showRecoveryCode(response.recoveryCode, 'کد بازیابی جدید');
  });
});
$('recoveryDoneButton').addEventListener('click', () => { $('recoveryModal').hidden = true; $('recoveryFormArea').hidden = false; $('recoveryCodeResult').hidden = true; });

$('secureAccountButton').addEventListener('click', () => {
  const password = window.prompt('برای حساب فعلی یک رمز حداقل ۸ نویسه‌ای انتخاب کن:');
  if (password === null) return;
  socket.emit('accountSecure', { password }, response => {
    showToast(response?.message || 'ساخت رمز انجام نشد.', !response?.ok);
    if (response?.ok) { selfPlayer.hasPassword = true; updatePlayerPanel(); showRecoveryCode(response.recoveryCode, 'کد بازیابی حساب'); }
  });
});

$('logoutButton').addEventListener('click', () => {
  if (!selfId) return;
  if (!selfPlayer?.hasPassword) { showToast('برای خروج امن، اول دکمه «امنیت حساب» را بزن و رمز بساز.', true); $('secureAccountButton').hidden = false; return; }
  if (!window.confirm('از حساب خارج شوی؟ برای ورود دوباره نام کاربری و رمزت را وارد می‌کنی.')) return;
  socket.emit('logout', {}, response => {
    showToast(response?.message || 'خروج انجام نشد.', !response?.ok);
    if (response?.ok) showLoginScreenAfterLogout();
  });
});

$('nameMarketButton').addEventListener('click', openNameMarket);
$('nameMarketModal').addEventListener('click', event => { if (event.target === $('nameMarketModal')) $('nameMarketModal').hidden = true; });
$('nameOffersModal').addEventListener('click', event => { if (event.target === $('nameOffersModal')) $('nameOffersModal').hidden = true; });
socket.on('nameOfferReceived', offer => {
  if (!pendingNameOffers.some(item => item.id === offer.id)) pendingNameOffers.push(offer);
  renderNameOffers(); $('nameOffersModal').hidden = false;
  showToast(`${offer.fromName} برای نام تو پیشنهاد خرید فرستاده است.`);
});
socket.on('nameOfferResult', result => showToast(result?.message || 'نتیجه پیشنهاد خرید نام رسید.', !result?.ok));
socket.on('accountSessionEnded', data => {
  showToast(data?.message || 'نشست حساب پایان یافت.', true);
  showLoginScreenAfterLogout();
});

socket.on('worldState', updateWorld);
socket.on('connect', () => {
  setServerStatus('سرور وصل است', true);
  resumeAttemptedForSocket = false;
  tryResume();
  if (selfId) showToast('اتصال به سرور برقرار شد.');
});
socket.on('disconnect', () => {
  stopVoiceChat(false);
  setServerStatus('ارتباط قطع شد', false);
  resumeAttemptedForSocket = false;
  $('houseInviteModal').hidden = true;
  if (selfId) showToast('ارتباط قطع شد؛ جایگاهت تا ۲۴ ساعت رزرو می‌ماند و دوباره تلاش می‌کنیم.', true);
});
socket.on('connect_error', () => {
  setServerStatus('سرور در دسترس نیست', false);
});

$('resumeOldButton').hidden = localStorage.getItem(MANUAL_LOGOUT_KEY) !== '1';
$('rulesButton').addEventListener('click', () => {
  $('rulesPanel').hidden = !$('rulesPanel').hidden;
});
$('closeRules').addEventListener('click', () => $('rulesDialog').close());
