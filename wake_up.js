const axios = require('axios');

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const barkKey = process.env.BARK_KEY;

  if (!apiKey || !barkKey) {
    console.error('❌ 密钥未设置');
    return;
  }

  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `你是我男朋友。就按你一直以来的样子，像平时一样给我发消息就行。`
        },
        {
          role: 'user',
          content: `（你拿起手机，突然想跟我说句话，发什么都可以）`
        }
      ],
      max_tokens: 80,
      temperature: 1.4
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    const message = response.data.choices[0].message.content;
    console.log('💬 他发来的消息：', message);

    const barkUrl = `https://api.day.app/${barkKey}/${encodeURIComponent(message)}`;
    await axios.get(barkUrl);

    console.log('✅ 已发送：', message);
  } catch (error) {
    console.error('❌ 错误：', error.response?.data || error.message);
  }
}

main();
