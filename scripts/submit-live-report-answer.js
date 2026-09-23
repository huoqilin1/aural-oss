async (page) => {
  const progress = await page.locator('body').innerText();
  const match = progress.match(/Q(\d+)\s*\/\s*8/);
  if (!match) throw new Error('No visible current question');
  const question = Number(match[1]);
  const answers = [
    '以下是虚构验收数据。我在虚构订单团队负责台账核对，对照订单号、数量和承诺日期发现遗漏，记录差异后交负责人确认。我只负责核对和更新，不负责审批价格。可核查依据是原订单和版本记录，没有量化提升数据，不编造比例。',
    '补充前面这段虚构回答：处理差异的依据是同一订单的原单、拣货记录和签收记录，先把数量及版本逐项核对，再请销售和仓库确认，审批通过才更新台账。我负责核验与记录，负责人负责审批；核验结果以确认记录为凭，不虚构实际业务金额。',
    '虚构案例中，我记录变更提出人、时间、数量和交付影响，给销售与交付负责人列出原计划及调整后的两个方案。由双方确认优先级和交付日期，我只同步更新版本。验收依据是确认记录与交付清单，不把协调结果归为我个人批准。',
    '我的虚构处理方法是先列出每项截止日期、对后续工作的依赖及延误影响，优先处理会阻塞交付的核对任务。冲突时列两个排期方案给主管决定，然后逐项更新台账。结果以负责人复核记录为准，没有统计收益数据。',
    '在虚构交付核验中，我逐项对照订单号、签收数量、签收日期与附件版本，缺少证明就标记待确认，联系对应负责人补证据。全部匹配后再更新完成状态，保留原记录和复核人。不能把没有凭证的交付写成已经成功。',
    '虚构场景中我漏填一次需求变更日期，发现后先说明影响范围，查原始沟通记录补齐并请负责人复核。我增加变更日期必填检查和每天下班前的遗漏核对。只有流程改动记录，没有长期统计，不声称降低了多少错误率。',
    '虚构工作方式中我用AI草拟核对清单和异常分类，输入脱敏字段，逐条对照原订单验证输出。遇到模型编造数量或不存在的附件就删除并记录错误；实际修改由负责人确认。AI不能代替我核验原始证据，也不向它提供客户私人信息。',
    '我的虚构入职计划是第一周学习现有流程和审批边界，第二周跟随同事核对少量订单，第三周在复核机制下独立处理，第四周请负责人抽检并修订清单。每周交付台账和差异记录。这是计划，不是已经完成的业绩，不承诺没有依据的效率比例。'
  ];
  await page.getByRole('textbox', { name: 'Type your response...' }).fill(answers[question-1]);
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/ai/chat') && r.request().method()==='POST', {timeout:240000});
  await page.getByRole('button', {name:'Send message', exact:true}).click();
  const response = await responsePromise;
  const body = await response.json();
  if (!response.ok()) throw new Error('Actual chat request failed');
  return {question,httpStatus:response.status(),advanced:body.questionAdvanced,complete:body.isComplete,reply:body.content?.slice(0,220)};
}
