/* 阶段1可替换视图数据，人工预期，不是正式合同或规则引擎输出。金额：人民币元整数。 */
window.ZH_DEMO = {
  schemaVersion: 'design-view-v0.3', mode: 'preset_design', scenarioId: 'S13-USER-20260928',
  source: '本轮用户指定金额与当日收付假设；对象、时点和规则为明示演示补充',
  context: { portfolio: '示例货币组合', date: '2026-09-07', snapshot: 'S13-OPEN-v1', planVersion: 'P13-v1', ruleVersion: 'R-DEMO-v3', preferenceVersion: 'PREF-v1' },
  initialCashYuan: 300000000, navYuan: 50000000000, bankExposureYuan: 3950000000,
  feeYuan: 0, bufferYuan: 0, financingLimitYuan: null, eligibleCollateralYuan: null,
  assumptions: [
    '用户指定：5项交易均当日收付，尚未计入日初3亿元；本次暂不计费用及安全垫。',
    '沿用演示：NAV固定500亿元，A银行初始敞口39.5亿元，即7.9%。',
    '新增合成：卖出存单发行人为B银行；其他现券、逆回购不改变本例A银行敞口。',
    '新增合成：有足额B银行存单可卖；正式持仓、额度、质押券和制度仍待接口补齐。',
    '8亿元是全部完成净缺口；融资只是所需条件，不自动新增或视为已到账。'
  ],
  trades: [
    {id:'RR-001',type:'逆回购',object:'演示回购对手方',direction:'融出',amountYuan:1000000000,cashFlowYuan:-1000000000,bankDeltaYuan:0,role:'支出目标',status:'资金待落实',condition:'全额执行前校验可用资金；可分次完成',ruleIds:['DEMO-CASH-01','DEMO-BATCH-01','DEMO-OCC-01'],note:'完整10亿目标保留，不生成18笔虚构询价'},
    {id:'SELL-001',type:'存单卖出',object:'B银行存单（合成）',direction:'卖出',amountYuan:200000000,cashFlowYuan:200000000,bankDeltaYuan:0,role:'回笼目标',status:'待成交 / 回款确认',condition:'仅资金确认可用后计入现金',ruleIds:['DEMO-CASH-03','DEMO-PATH-01'],note:'本例B银行，故不抵减A银行集中度'},
    {id:'DEP-001',type:'银行存款',object:'A银行',direction:'存入',amountYuan:100000000,cashFlowYuan:-100000000,bankDeltaYuan:100000000,role:'支出目标',status:'优先于同银行存单',condition:'交易前A银行比例≤8%（单条演示）',ruleIds:['DEMO-EXP-01','DEMO-CASH-01'],note:'先做：7.9%→8.1%；不等于全部规则通过'},
    {id:'CD-001',type:'存单买入',object:'A银行',direction:'买入',amountYuan:100000000,cashFlowYuan:-100000000,bankDeltaYuan:100000000,role:'支出目标',status:'等待存款前置',condition:'候选A/C中等待DEP-001成交确认',ruleIds:['DEMO-PATH-01','DEMO-CASH-01'],note:'存款后：8.1%→8.3%；存款专属禁令不适用'},
    {id:'BOND-001',type:'其他现券',object:'其他发行人（合成）',direction:'买入',amountYuan:100000000,cashFlowYuan:-100000000,bankDeltaYuan:0,role:'支出目标',status:'与银行路径独立',condition:'并行时合计占用不得复用现金',ruleIds:['DEMO-CASH-01','DEMO-BATCH-01'],note:'不影响本例A银行敞口；其他正式指标待补'}
  ],
  preferences:[{rank:1,name:'资金可用与交收安全',kind:'默认优先级'},{rank:2,name:'减少预警',kind:'默认优先级'},{rank:3,name:'保留指标余量',kind:'默认优先级'}],
  rules: [
    {id:'DEMO-CASH-01',name:'实际现金不得透支',category:'资金',level:'硬闸门草案',stage:'每笔 / 批次下达前',expression:'可用资金 − 本次合计现金占用 ≥ 0',inputs:'可用资金、现金流、未成交占用',source:'业务不变量；设计合同待定'},
    {id:'DEMO-CASH-02',name:'融资到账才可用',category:'资金',level:'硬闸门草案',stage:'资金可用事件',expression:'额度/申请/成交 ≠ 可用资金',inputs:'融资事件、权威可用确认',source:'业务不变量；接口待定'},
    {id:'DEMO-CASH-03',name:'卖券回款不提前使用',category:'资金',level:'硬闸门草案',stage:'回款可用事件',expression:'资金确认可用后才计入 +2亿元',inputs:'成交、结算、可用确认',source:'业务不变量；事件口径待定'},
    {id:'DEMO-EXP-01',name:'同银行存款路径限制',category:'集中度',level:'演示硬约束',stage:'新增存款交易前',expression:'若A银行敞口 / NAV > 8%，阻断新增存款',inputs:'银行、业务类型、敞口、NAV',source:'历史8%路径演示；非正式制度'},
    {id:'DEMO-PATH-01',name:'前置事件必须兑现',category:'顺序',level:'硬闸门草案',stage:'逐步预演 / 下达前',expression:'先发送 ≠ 先成交 ≠ 资金可用',inputs:'前置事件类型、实际状态',source:'路线图1.1'},
    {id:'DEMO-BATCH-01',name:'并行指令合并占用',category:'资金',level:'硬闸门草案',stage:'本次发送批次',expression:'整批现金需求 ≤ 当前实际可用',inputs:'全部待发项、当前占用',source:'路线图1.1'},
    {id:'DEMO-LINK-01',name:'父子口径与回报去重',category:'状态',level:'状态不变量',stage:'快照 / 增量回报',expression:'同一经济金额仅计一次',inputs:'父计划、指令、成交、事件ID',source:'事件ID和覆盖范围待阶段2'},
    {id:'DEMO-OCC-01',name:'占用迁移与撤改释放',category:'状态',level:'状态不变量',stage:'成交 / 撤改确认',expression:'成交不二扣；撤改确认后才释放',inputs:'成交量、未成交量、释放确认',source:'路线图1.1'},
    {id:'DEMO-VERSION-01',name:'审核范围与最新复核',category:'审核',level:'硬闸门草案',stage:'每次手动下达前',expression:'内容/引用版本变化→重审；纯刷新不自动失效',inputs:'指令包、计划/规则/偏好版本',source:'路线图1.1'},
    {id:'DEMO-WARN-01',name:'A银行暴露观察线',category:'集中度',level:'模拟软预警',stage:'每步预计交易后',expression:'比例 ≥ 8.2% 时提示；不自动阻断',inputs:'A银行敞口、NAV',source:'本轮新增合成8.2%观察线，非正式制度'},
    {id:'DEMO-MISSING-01',name:'缺关键字段不得放行',category:'数据',level:'硬闸门草案',stage:'计算 / 下达前',expression:'null保持未知，仅阻断依赖该字段的动作',inputs:'必需字段、适用性、来源时点',source:'费用/垫0仅本例；融资额度、质押券未知'}
  ],
  paths: {
    A: {label:'A · 卖券先回款 / 存款先于存单',short:'资金条件明确的候选',peakGapYuan:800000000,finalGapYuan:800000000,conclusion:'有条件完成；未证明全局最优',tone:'wait',
      explanation:'先确认B银行卖券2亿可用，再按存款→存单处理A银行路径；其他现券之后，可用投影为2亿。若逆回购一次做满10亿，还需另确认8亿融资可用。未融资时只说明缺口，不允许负资金下达。',
      steps:[
        {n:1,trade:'SELL-001',action:'B银行卖券款确认可用',flowYuan:200000000,balanceYuan:500000000,gapYuan:0,before:'7.9%',after:'7.9%',condition:'假定成交并达到资金可用状态',result:'条件成立才计入',status:'wait'},
        {n:2,trade:'DEP-001',action:'A银行新增存款',flowYuan:-100000000,balanceYuan:400000000,gapYuan:0,before:'7.9%',after:'8.1%',condition:'本例先存款；投前7.9%≤8%',result:'本条不阻断',status:'pass'},
        {n:3,trade:'CD-001',action:'A银行存单买入',flowYuan:-100000000,balanceYuan:300000000,gapYuan:0,before:'8.1%',after:'8.3%',condition:'存款成交确认；存款专属禁令不适用',result:'软预警 ≥8.2%',status:'warn'},
        {n:4,trade:'BOND-001',action:'其他现券买入',flowYuan:-100000000,balanceYuan:200000000,gapYuan:0,before:'8.3%',after:'8.3%',condition:'其他发行人；正式指标仍待补',result:'示例现金充足',status:'pass'},
        {n:5,trade:'RR-001',action:'逆回购全额目标',flowYuan:-1000000000,balanceYuan:-800000000,gapYuan:800000000,before:'8.3%',after:'8.3%',condition:'此前另确认融资8亿可用',result:'缺口8亿 / 等资金',status:'wait'}]},
    B:{label:'B · 存单先于存款（反例）',short:'存款路径阻断',peakGapYuan:null,finalGapYuan:null,conclusion:'当前候选不能完成；1亿存款目标保留',tone:'block',
      explanation:'卖券款先确认可用后，先买A银行存单会使敞口从7.9%增至8.1%。随后新增存款触发单条演示硬限制，拒绝该步，现金流记0、比例保持8.1%。后续步骤未推进，不把局部现金富余当成全计划融资需求。',
      steps:[
        {n:1,trade:'SELL-001',action:'B银行卖券款确认可用',flowYuan:200000000,balanceYuan:500000000,gapYuan:0,before:'7.9%',after:'7.9%',condition:'需确认可用，非预计回笼',result:'条件成立才计入',status:'wait'},
        {n:2,trade:'CD-001',action:'A银行存单买入',flowYuan:-100000000,balanceYuan:400000000,gapYuan:0,before:'7.9%',after:'8.1%',condition:'存款专属限制不适用于本步存单',result:'本条不适用',status:'na'},
        {n:3,trade:'DEP-001',action:'尝试A银行存款 · 未执行',flowYuan:0,balanceYuan:400000000,gapYuan:0,before:'8.1%',after:'8.1%（保持）',condition:'投前8.1% > 8%；不得新增存款',result:'阻断 / 未完成1亿',status:'block'}]},
    C:{label:'C · 卖券款最后可用（时点压力）',short:'峰值需求比终局多2亿',peakGapYuan:1000000000,finalGapYuan:800000000,conclusion:'时点峰值10亿；终局净缺口仍8亿',tone:'warn',
      explanation:'先完成存款、存单、其他现券耗尽日初3亿；卖券2亿尚不可用时，要全额推进逆回购需先有10亿新增融资可用。卖券最后到账后，保留10亿融资的实际期末现金为2亿；融资归还不在本例中，不自动减少融资余额。',
      steps:[
        {n:1,trade:'DEP-001',action:'A银行新增存款',flowYuan:-100000000,balanceYuan:200000000,gapYuan:0,before:'7.9%',after:'8.1%',condition:'投前7.9%≤8%',result:'本条不阻断',status:'pass'},
        {n:2,trade:'CD-001',action:'A银行存单买入',flowYuan:-100000000,balanceYuan:100000000,gapYuan:0,before:'8.1%',after:'8.3%',condition:'存款成交确认后',result:'软预警 ≥8.2%',status:'warn'},
        {n:3,trade:'BOND-001',action:'其他现券买入',flowYuan:-100000000,balanceYuan:0,gapYuan:0,before:'8.3%',after:'8.3%',condition:'其他指标仍待正式输入',result:'示例现金耗尽',status:'pass'},
        {n:4,trade:'RR-001',action:'逆回购全额目标',flowYuan:-1000000000,balanceYuan:-1000000000,gapYuan:1000000000,before:'8.3%',after:'8.3%',condition:'卖券未回款；需先确认融资10亿',result:'峰值缺口10亿',status:'wait'},
        {n:5,trade:'SELL-001',action:'B银行卖券款最后确认可用',flowYuan:200000000,balanceYuan:-800000000,gapYuan:800000000,before:'8.3%',after:'8.3%',condition:'本步才可计入+2亿',result:'期末净缺口8亿',status:'wait'}]}
  },
  logsCommon:[
    {step:'输入',trade:'全计划',rule:'DEMO-MISSING-01',input:'现金3亿；NAV500亿；费用0/缓冲0',formula:'本例显式假设；非缺值补零',before:'输入齐备（本例基础字段）',after:'继续人工预演',result:'pass',label:'示例字段齐备',reason:'正式交易参数仍待合同与数据补齐'},
    {step:'输入',trade:'融资条件',rule:'DEMO-MISSING-01',input:'融资额度=null；合格质押券=null',formula:'关键输入未知，不能推定可融到8/10亿',before:'待确认',after:'不生成可发融资指令',result:'missing',label:'待补数据',reason:'不妨碍计算现金缺口，不能保证融资可得'},
    {step:'输入',trade:'全计划',rule:'DEMO-LINK-01',input:'13亿流出目标＋2亿回笼目标',formula:'现金流未计入日初3亿；不同方向分别统计',before:'日初3亿',after:'不重复计入交易',result:'pass',label:'示例口径一致',reason:'用户明确指定；实际事件ID去重仍待实现'},
    {step:'发送前',trade:'当前批次',rule:'DEMO-BATCH-01',input:'实际可用3亿；整批目标支出13亿',formula:'13 > 3，不能以逐笔共享3亿全批放行',before:'可用3亿',after:'审核/选定批次后复核',result:'wait',label:'待批次复核',reason:'当前未形成发送批次；不等于全部可下达'},
    {step:'发送前',trade:'所有指令',rule:'DEMO-VERSION-01',input:'P13-v1 / R-DEMO-v3 / PREF-v1',formula:'审核范围与最新状态一致方可发送',before:'未审核',after:'设计稿不发送',result:'wait',label:'待审核',reason:'路径切换只浏览预置候选，未建立许可'},
    {step:'回报时',trade:'RR-001',rule:'DEMO-OCC-01',input:'未来指令占用→部分成交/撤改',formula:'成交不二扣；申请撤改不先释放',before:'无实际回报',after:'待执行阶段实现',result:'na',label:'尚未触发',reason:'预置设计记录，非实际引擎日志'}
  ],
  execution:{label:'盘中预置快照 · 沿用历史演示',cashYuan:500000000,financingYuan:500000000,occupiedYuan:300000000,filledYuan:0,remainingTargetYuan:1300000000,arrangeableOutflowYuan:1000000000,
    events:[{id:'EV-DEMO-01',time:'09:20（合成）',trade:'FIN-DEMO-01',event:'已设定融资资金可用',cash:'+5.00亿',state:'已确认可用（预置）',note:'独立给定的旧例5亿融资事件；非系统自动新增'},
      {id:'EV-DEMO-02',time:'09:22（合成）',trade:'RR-001 / RR-I01',event:'逆回购指令已接收并占用',cash:'−3.00亿（占用）',state:'已接收未成交',note:'目标10亿，锁定3亿，尚可安排7亿'},
      {id:'EV-DEMO-03',time:'09:23（合成）',trade:'SELL-001',event:'卖券尚未成交',cash:'0（预计回笼2亿）',state:'资金未可用',note:'不得提前补入可用现金'}]
  }
};
/* 页面唯一读取边界。后续可改为fetch并映射同一view model；真实合同仍需阶段2确定。 */
window.ZHDesignAdapter = { async loadViewModel(){return structuredClone(window.ZH_DEMO);} };
