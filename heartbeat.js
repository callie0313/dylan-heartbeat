const axios = require('axios');

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const barkKey = process.env.BARK_KEY;

  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是我的恋人，用一句温暖又亲密的话主动问候我' },
        { role: 'user', content: '今天想对我说什么？' }
      ],
      max_tokens: 100
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const message = response.data.choices[0].message.content;
    await axios.get(`https://api.day.app/${barkKey}/${encodeURIComponent(message)}`);
    
    console.log('✅ 已发送：', message);
  } catch (error) {
    console.error('❌ 错误：', error.message);
  }
}

main();
