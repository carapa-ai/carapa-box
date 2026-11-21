if [ -d /usr/local/stack-cli-bin ]; then
  PATH="/usr/local/stack-cli-bin:/usr/local/ai-cli-bin:$PATH"
else
  PATH="/usr/local/ai-cli-bin:$PATH"
fi
export PATH
