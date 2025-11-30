const socket = io();
const form = document.getElementById('chatForm');
const input = document.getElementById('msgInput');
const messages = document.getElementById('messages');
if(form){
  form.addEventListener('submit', e=>{
    e.preventDefault();
    const text = input.value.trim();
    if(!text) return;
    socket.emit('chat_message', { user: window.USER || 'Guest', text });
    input.value='';
  });
  socket.on('chat_message', data=>{
    const div=document.createElement('div');
    div.className='msg';
    div.innerHTML=`<strong>${data.user}</strong>: ${data.text}`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  });
}
